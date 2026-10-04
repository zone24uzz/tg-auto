/** Raw-media object storage (only used when settings.retainRawMedia is on). */
export interface StorageDriver {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  /** null when the object does not exist. */
  get(key: string): Promise<Buffer | null>;
  /** Idempotent: deleting a missing object is not an error. */
  delete(key: string): Promise<void>;
}

export const STORAGE_KEY_PATTERN = /^[a-zA-Z0-9/_.-]+$/;
const MAX_KEY_LENGTH = 512;

export class InvalidStorageKeyError extends Error {
  constructor(reason: string) {
    super(`invalid storage key: ${reason}`);
    this.name = 'InvalidStorageKeyError';
  }
}

/** Keys are relative, slash-separated, [a-zA-Z0-9/_.-] only, without empty/"."/".." segments. */
export function validateStorageKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0) throw new InvalidStorageKeyError('empty');
  if (key.length > MAX_KEY_LENGTH) throw new InvalidStorageKeyError('too long');
  if (!STORAGE_KEY_PATTERN.test(key)) throw new InvalidStorageKeyError('illegal characters');
  if (key.startsWith('/') || key.endsWith('/')) throw new InvalidStorageKeyError('leading or trailing slash');
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw new InvalidStorageKeyError('bad path segment');
  }
  return key;
}

/** Key used for retained raw media. */
export function mediaStorageKey(messageId: number, mediaId: number, ext: string): string {
  const safeExt = /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'bin';
  return validateStorageKey(`media/${Math.trunc(messageId)}/${Math.trunc(mediaId)}.${safeExt}`);
}
