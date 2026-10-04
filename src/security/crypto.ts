import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX = 'enc:v1:';

/** Binary envelope: MAGIC ("TGAE") | version (1 byte) | iv (12) | tag (16) | ciphertext. */
const BUFFER_MAGIC = Buffer.from('TGAE', 'latin1');
const BUFFER_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BUFFER_HEADER_BYTES = BUFFER_MAGIC.length + 1 + IV_BYTES + TAG_BYTES;

/** A binary payload is encrypted but cannot be decrypted (no key, wrong key, tampered or unknown version). */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

/**
 * AES-256-GCM field encryption for private message content at rest.
 * Values are stored as `enc:v1:<iv>.<tag>.<ciphertext>` (base64url).
 * Binary payloads (retained raw media) use a versioned header, see {@link ContentCipher.encryptBuffer}.
 * Without a key the cipher is a no-op, and legacy plaintext values stay readable.
 */
export class ContentCipher {
  private readonly key: Buffer | null;

  constructor(base64Key: string | undefined) {
    this.key = base64Key ? Buffer.from(base64Key, 'base64') : null;
    if (this.key && this.key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes');
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  encrypt(value: string): string;
  encrypt(value: string | null | undefined): string | null;
  encrypt(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    if (!this.key) return value;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
  }

  decrypt(value: string): string;
  decrypt(value: string | null | undefined): string | null;
  decrypt(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    if (!value.startsWith(PREFIX)) return value;
    if (!this.key) return '[encrypted]';
    const [ivB64, tagB64, ctB64] = value.slice(PREFIX.length).split('.');
    if (!ivB64 || !tagB64 || ctB64 === undefined) return '[unreadable]';
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      return '[unreadable]';
    }
  }

  /** True when `data` starts with the encrypted-buffer header (any version). */
  static isEncryptedBuffer(data: Buffer): boolean {
    return data.length >= BUFFER_MAGIC.length + 1 && data.subarray(0, BUFFER_MAGIC.length).equals(BUFFER_MAGIC);
  }

  /**
   * Encrypts a binary payload: `TGAE | 0x01 | iv | tag | ciphertext` (AES-256-GCM).
   * Without a key the data is returned unchanged.
   */
  encryptBuffer(data: Buffer): Buffer {
    if (!this.key) return data;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([BUFFER_MAGIC, Buffer.from([BUFFER_VERSION]), iv, cipher.getAuthTag(), ct]);
  }

  /**
   * Decrypts a payload produced by {@link encryptBuffer}. Data without the header (stored before
   * encryption was enabled) is returned unchanged. Throws DecryptionError when the payload is
   * encrypted but cannot be read (no key, wrong key, tampered, unknown version).
   */
  decryptBuffer(data: Buffer): Buffer {
    if (!ContentCipher.isEncryptedBuffer(data)) return data;
    const version = data[BUFFER_MAGIC.length];
    if (version !== BUFFER_VERSION) throw new DecryptionError(`unsupported encrypted buffer version ${version ?? '?'}`);
    if (!this.key) throw new DecryptionError('encrypted data cannot be read without DATA_ENCRYPTION_KEY');
    if (data.length < BUFFER_HEADER_BYTES) throw new DecryptionError('encrypted data is truncated');
    let offset = BUFFER_MAGIC.length + 1;
    const iv = data.subarray(offset, (offset += IV_BYTES));
    const tag = data.subarray(offset, (offset += TAG_BYTES));
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data.subarray(offset)), decipher.final()]);
    } catch {
      throw new DecryptionError('encrypted data could not be decrypted (wrong key or tampered)');
    }
  }
}

/** Constant-time string comparison (webhook secrets etc.). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
