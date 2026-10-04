import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { sanitizeText } from '../logging/sanitize.js';
import { extensionOf, safeTempPath, sniffMime, type SniffedType } from '../security/files.js';
import { MediaProcessingError, MediaTooLargeError } from './errors.js';
import { readHead, removeQuietly } from './fs-utils.js';
import { CLOUD_BOT_API_MAX_BYTES } from './limits.js';

export { MediaTooLargeError } from './errors.js';

const CLOUD_API_HOST = 'api.telegram.org';

export interface DownloadOptions {
  /** Hard limit; the download is aborted (and the partial file deleted) beyond it. */
  maxBytes: number;
  /** Temp file extension (a-z0-9). Defaults to the extension of Telegram's file_path, else "bin". */
  ext?: string;
  /** Size known from the update (Media.fileSize); lets us refuse before calling getFile. */
  knownSize?: number | null;
}

export interface DownloadedFile {
  /** Temp path inside tmpDir (random name). The caller deletes it. */
  path: string;
  size: number;
  sniffed: SniffedType;
}

/** What MediaService needs; implemented by TelegramFileDownloader (and fakes in tests). */
export interface FileDownloader {
  download(fileId: string, opts: DownloadOptions): Promise<DownloadedFile>;
}

/** Download failed for a reason other than size (network, HTTP error, missing file_path…). */
export class TelegramFileError extends MediaProcessingError {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramFileError';
  }
}

export interface TelegramFileDownloaderOptions {
  token: string;
  /** e.g. https://api.telegram.org or a self-hosted Bot API server. */
  apiRoot: string;
  tmpDir: string;
  /** Per-request timeout for getFile (default 20 s). */
  getFileTimeoutMs?: number;
  /** Timeout for the file transfer itself (default 180 s). */
  downloadTimeoutMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

interface TelegramGetFileResponse {
  ok: boolean;
  description?: string;
  result?: { file_id?: string; file_size?: number; file_path?: string };
}

/**
 * Downloads Telegram files by file_id into the media temp dir.
 * Error messages never contain the bot token or the file URL.
 */
export class TelegramFileDownloader implements FileDownloader {
  private readonly token: string;
  private readonly apiRoot: string;
  private readonly tmpDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getFileTimeoutMs: number;
  private readonly downloadTimeoutMs: number;
  readonly isCloudApi: boolean;

  constructor(opts: TelegramFileDownloaderOptions) {
    this.token = opts.token;
    this.apiRoot = opts.apiRoot.replace(/\/+$/, '');
    this.tmpDir = path.resolve(opts.tmpDir);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.getFileTimeoutMs = opts.getFileTimeoutMs ?? 20_000;
    this.downloadTimeoutMs = opts.downloadTimeoutMs ?? 180_000;
    this.isCloudApi = isCloudBotApi(this.apiRoot);
  }

  async download(fileId: string, opts: DownloadOptions): Promise<DownloadedFile> {
    const limit = this.effectiveLimit(opts.maxBytes);
    if (opts.knownSize !== null && opts.knownSize !== undefined && opts.knownSize > limit) {
      throw this.tooLarge(opts.knownSize, limit);
    }
    await mkdir(this.tmpDir, { recursive: true });

    const info = await this.getFile(fileId);
    if (info.file_size !== undefined && info.file_size > limit) throw this.tooLarge(info.file_size, limit);
    const filePath = info.file_path;
    if (!filePath) throw new TelegramFileError('Telegram returned no file_path (file is not downloadable)');
    validateFilePath(filePath);

    const ext = opts.ext && /^[a-z0-9]{1,8}$/.test(opts.ext) ? opts.ext : extensionOf(filePath) || 'bin';
    const dest = safeTempPath(this.tmpDir, ext);
    try {
      const size =
        !this.isCloudApi && path.isAbsolute(filePath)
          ? await this.copyLocal(filePath, dest, limit)
          : await this.fetchToFile(filePath, dest, limit);
      const sniffed = sniffMime(await readHead(dest, 64));
      return { path: dest, size, sniffed };
    } catch (error) {
      await removeQuietly(dest);
      throw this.sanitizeError(error);
    }
  }

  private effectiveLimit(maxBytes: number): number {
    const max = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
    return this.isCloudApi ? Math.min(max, CLOUD_BOT_API_MAX_BYTES) : max;
  }

  private tooLarge(size: number | undefined, limit: number): MediaTooLargeError {
    const cloudCap = this.isCloudApi && limit >= CLOUD_BOT_API_MAX_BYTES;
    const why = cloudCap ? 'the 20 MB cloud Bot API download limit' : `the ${limit} byte limit`;
    return new MediaTooLargeError(`file${size !== undefined ? ` (${size} bytes)` : ''} exceeds ${why}`, {
      sizeBytes: size,
      limitBytes: limit,
    });
  }

  private async getFile(fileId: string): Promise<NonNullable<TelegramGetFileResponse['result']>> {
    const url = `${this.apiRoot}/bot${this.token}/getFile?file_id=${encodeURIComponent(fileId)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(this.getFileTimeoutMs) });
    } catch (error) {
      throw new TelegramFileError(`getFile request failed: ${this.scrub(errorMessage(error))}`);
    }
    let body: TelegramGetFileResponse | null;
    try {
      body = (await res.json()) as TelegramGetFileResponse;
    } catch {
      body = null;
    }
    if (!res.ok || !body || body.ok !== true || !body.result) {
      const description = this.scrub(String(body?.description ?? '')).slice(0, 200);
      if (/file is too big/i.test(description)) {
        throw new MediaTooLargeError('file exceeds the Bot API download limit', {
          limitBytes: this.isCloudApi ? CLOUD_BOT_API_MAX_BYTES : undefined,
        });
      }
      throw new TelegramFileError(`getFile failed: HTTP ${res.status}${description ? ` (${description})` : ''}`);
    }
    return body.result;
  }

  private async fetchToFile(filePath: string, dest: string, limit: number): Promise<number> {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const url = `${this.apiRoot}/file/bot${this.token}/${encodedPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.downloadTimeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method: 'GET', signal: controller.signal });
      } catch (error) {
        throw new TelegramFileError(`file download failed: ${this.scrub(errorMessage(error))}`);
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        throw new TelegramFileError(`file download failed: HTTP ${res.status}`);
      }
      const declared = Number(res.headers.get('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > limit) {
        await res.body.cancel().catch(() => undefined);
        throw this.tooLarge(declared, limit);
      }
      let total = 0;
      const body = res.body;
      const tooLarge = () => this.tooLarge(undefined, limit);
      async function* limited(): AsyncGenerator<Uint8Array> {
        for await (const chunk of body) {
          total += chunk.byteLength;
          if (total > limit) throw tooLarge();
          yield chunk;
        }
      }
      await pipeline(limited(), createWriteStream(dest, { flags: 'wx', mode: 0o600 }));
      return total;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  /** Self-hosted Bot API server in --local mode returns an absolute path on a shared volume. */
  private async copyLocal(source: string, dest: string, limit: number): Promise<number> {
    const info = await stat(source).catch(() => {
      throw new TelegramFileError('local Bot API file is not accessible from this process');
    });
    if (!info.isFile()) throw new TelegramFileError('local Bot API path is not a regular file');
    if (info.size > limit) throw this.tooLarge(info.size, limit);
    let total = 0;
    const tooLarge = () => this.tooLarge(undefined, limit);
    async function* limited(src: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
      for await (const chunk of src) {
        total += chunk.byteLength;
        if (total > limit) throw tooLarge();
        yield chunk;
      }
    }
    await pipeline(createReadStream(source), limited, createWriteStream(dest, { flags: 'wx', mode: 0o600 }));
    return total;
  }

  private scrub(text: string): string {
    let out = text;
    if (this.token) out = out.split(this.token).join('[REDACTED]');
    // Drop URLs entirely: Bot API URLs embed the token.
    out = out.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, '[url]');
    return sanitizeText(out);
  }

  private sanitizeError(error: unknown): Error {
    if (error instanceof MediaTooLargeError || error instanceof TelegramFileError) {
      error.message = this.scrub(error.message);
      return error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return new TelegramFileError('file download timed out');
    }
    return new TelegramFileError(`file download failed: ${this.scrub(errorMessage(error))}`);
  }
}

export function isCloudBotApi(apiRoot: string): boolean {
  try {
    return new URL(apiRoot).hostname.toLowerCase() === CLOUD_API_HOST;
  } catch {
    return false;
  }
}

/** Rejects traversal and control characters in Telegram's file_path. */
export function validateFilePath(filePath: string): void {
  // eslint-disable-next-line no-control-regex
  if (filePath.length > 4096 || /[\u0000-\u001f]/.test(filePath)) {
    throw new TelegramFileError('invalid file_path returned by Telegram');
  }
  const segments = filePath.split(/[\\/]+/);
  if (segments.some((s) => s === '..') || filePath.includes('..')) {
    throw new TelegramFileError('invalid file_path returned by Telegram (traversal)');
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? `: ${cause.message}` : '';
    return `${error.name}: ${error.message}${causeMsg}`;
  }
  return String(error);
}
