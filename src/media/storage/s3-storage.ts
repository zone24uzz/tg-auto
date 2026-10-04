import { AwsClient } from 'aws4fetch';
import { sanitizeText } from '../../logging/sanitize.js';
import { validateStorageKey, type StorageDriver } from './storage.js';

export interface S3StorageOptions {
  /** e.g. https://s3.eu-central-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com, https://<ref>.supabase.co/storage/v1/s3 */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  timeoutMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

export class S3StorageError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'S3StorageError';
  }
}

/** S3-compatible storage (AWS S3, Cloudflare R2, Supabase S3…) with SigV4 via aws4fetch, path-style URLs. */
export class S3Storage implements StorageDriver {
  private readonly client: AwsClient;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: S3StorageOptions) {
    if (!/^https?:\/\//i.test(opts.endpoint)) throw new S3StorageError('S3 endpoint must be an http(s) URL');
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/i.test(opts.bucket)) throw new S3StorageError('invalid S3 bucket name');
    this.client = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      service: 's3',
      region: opts.region || 'auto',
    });
    this.base = `${opts.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(opts.bucket)}`;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private url(key: string): string {
    validateStorageKey(key);
    return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private async send(method: string, key: string, init: { body?: Buffer; headers?: Record<string, string> } = {}) {
    const request = await this.client.sign(this.url(key), {
      method,
      headers: init.headers,
      body: init.body,
    });
    try {
      return await this.fetchImpl(request, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new S3StorageError(`S3 ${method} request failed: ${sanitizeText(msg)}`);
    }
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    const res = await this.send('PUT', key, {
      body: data,
      headers: {
        'content-type': /^[\w.+-]+\/[\w.+-]+$/.test(contentType) ? contentType : 'application/octet-stream',
      },
    });
    if (!res.ok) throw await this.failure('PUT', res);
    await res.body?.cancel().catch(() => undefined);
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await this.send('GET', key);
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!res.ok) throw await this.failure('GET', res);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const res = await this.send('DELETE', key);
    if (!res.ok && res.status !== 404) throw await this.failure('DELETE', res);
    await res.body?.cancel().catch(() => undefined);
  }

  private async failure(method: string, res: Response): Promise<S3StorageError> {
    let code = '';
    try {
      const text = (await res.text()).slice(0, 2000);
      code = /<Code>([^<]{1,64})<\/Code>/.exec(text)?.[1] ?? '';
    } catch {
      // ignore
    }
    return new S3StorageError(`S3 ${method} failed: HTTP ${res.status}${code ? ` ${sanitizeText(code)}` : ''}`, res.status);
  }
}
