import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { Api } from 'telegram';
import { MTPROTO_FILE_PREFIX } from '../../app/userbot-contract.js';
import { describeError } from '../../logging/sanitize.js';
import { MediaProcessingError, MediaTooLargeError } from '../../media/errors.js';
import { readHead, removeQuietly } from '../../media/fs-utils.js';
import type { DownloadedFile, DownloadOptions, FileDownloader } from '../../media/telegram-file.js';
import { safeTempPath, sniffMime } from '../../security/files.js';
import { extractMtprotoMedia } from './normalizer.js';
import type { PeerClient, PeerResolver } from './peers.js';

/** Download failure that is not about size (not connected, message gone, network…). */
export class MtprotoFileError extends MediaProcessingError {
  constructor(message: string) {
    super(message);
    this.name = 'MtprotoFileError';
  }
}

/** The part of the GramJS client the downloader uses (TelegramClient satisfies it). */
export interface DownloadClient extends PeerClient {
  getMessages(entity: Api.TypeInputPeer, params: { ids: number }): Promise<ArrayLike<Api.Message | undefined>>;
  downloadMedia(
    message: Api.Message,
    params: { outputFile: WriteStream; progressCallback: (downloaded: { toJSNumber(): number }) => void },
  ): Promise<unknown>;
}

export interface MtprotoFileRef {
  chatId: bigint;
  messageId: number;
}

const REF_RE = /^(\d{1,20}):(\d{1,10})(?::\d{1,3})?$/;

/** Parses `mt:<chatId>:<messageId>[:<index>]`. */
export function parseMtprotoFileRef(fileId: string): MtprotoFileRef {
  const match = fileId.startsWith(MTPROTO_FILE_PREFIX) ? REF_RE.exec(fileId.slice(MTPROTO_FILE_PREFIX.length)) : null;
  const messageId = match ? Number(match[2]) : NaN;
  if (!match || !Number.isSafeInteger(messageId) || messageId <= 0 || messageId > 2_147_483_647) {
    throw new MtprotoFileError('invalid MTProto file reference');
  }
  return { chatId: BigInt(match[1]!), messageId };
}

function tooLarge(size: number | undefined, limit: number): MediaTooLargeError {
  return new MediaTooLargeError(`file${size !== undefined ? ` (${size} bytes)` : ''} exceeds the ${limit} byte limit`, {
    sizeBytes: size,
    limitBytes: limit,
  });
}

/**
 * Downloads media of messages received by the userbot (`mt:` file ids) into the media temp dir,
 * enforcing the same size limit as the Bot API downloader (before and while downloading).
 */
export class MtprotoDownloader implements FileDownloader {
  private readonly tmpDir: string;

  constructor(
    private readonly getClient: () => DownloadClient | null,
    private readonly peers: PeerResolver,
    tmpDir: string,
  ) {
    this.tmpDir = path.resolve(tmpDir);
  }

  async download(fileId: string, opts: DownloadOptions): Promise<DownloadedFile> {
    const ref = parseMtprotoFileRef(fileId);
    const limit = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? Math.floor(opts.maxBytes) : 0;
    if (opts.knownSize !== null && opts.knownSize !== undefined && opts.knownSize > limit) throw tooLarge(opts.knownSize, limit);

    const client = this.getClient();
    if (!client) throw new MtprotoFileError('userbot is not connected; cannot download MTProto media');
    const message = await this.fetchMessage(client, ref);
    const size = extractMtprotoMedia(message, ref.chatId).media[0]?.fileSize;
    if (size !== undefined && size > limit) throw tooLarge(size, limit);

    await mkdir(this.tmpDir, { recursive: true });
    const ext = opts.ext && /^[a-z0-9]{1,8}$/.test(opts.ext) ? opts.ext : 'bin';
    const dest = safeTempPath(this.tmpDir, ext);
    try {
      await this.downloadTo(client, message, dest, limit);
      const info = await stat(dest);
      if (info.size > limit) throw tooLarge(info.size, limit);
      if (info.size === 0) throw new MtprotoFileError('downloaded file is empty');
      const sniffed = sniffMime(await readHead(dest, 64));
      return { path: dest, size: info.size, sniffed };
    } catch (error) {
      await removeQuietly(dest);
      throw toDownloadError(error);
    }
  }

  private async fetchMessage(client: DownloadClient, ref: MtprotoFileRef): Promise<Api.Message> {
    let found: Api.Message | undefined;
    try {
      const peer = await this.peers.resolve(client, ref.chatId);
      const list = await client.getMessages(peer, { ids: ref.messageId });
      found = list[0];
    } catch (error) {
      throw new MtprotoFileError(`could not fetch the message: ${describeError(error, 200)}`);
    }
    if (!(found instanceof Api.Message) || !found.media) throw new MtprotoFileError('message or its media is no longer available');
    return found;
  }

  private async downloadTo(client: DownloadClient, message: Api.Message, dest: string, limit: number): Promise<void> {
    const out = createWriteStream(dest, { flags: 'wx', mode: 0o600 });
    const closed = once(out, 'close').then(
      () => undefined,
      (error: unknown) => error,
    );
    let failure: unknown;
    try {
      await client.downloadMedia(message, {
        outputFile: out,
        progressCallback: (downloaded) => {
          const received = downloaded.toJSNumber();
          if (received > limit) throw tooLarge(undefined, limit); // aborts the GramJS download loop
        },
      });
    } catch (error) {
      failure = error;
    } finally {
      // GramJS closes the stream itself; make sure it is flushed and closed before stat/unlink.
      if (!out.writableEnded) out.end();
      const streamError = await closed;
      failure ??= streamError;
    }
    if (failure !== undefined) throw failure;
  }
}

function toDownloadError(error: unknown): Error {
  if (error instanceof MediaTooLargeError || error instanceof MediaProcessingError) return error;
  return new MtprotoFileError(`file download failed: ${describeError(error, 200)}`);
}
