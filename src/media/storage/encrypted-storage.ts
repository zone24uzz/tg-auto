import type { ContentCipher } from '../../security/crypto.js';
import type { StorageDriver } from './storage.js';

/** Content type of encrypted objects (the real type is not revealed to the storage backend). */
export const ENCRYPTED_CONTENT_TYPE = 'application/octet-stream';

/**
 * Encrypts retained raw media before it reaches the storage backend and decrypts it on read
 * (AES-256-GCM via ContentCipher). Without DATA_ENCRYPTION_KEY it is a transparent pass-through;
 * objects stored before encryption was enabled stay readable.
 */
export class EncryptedStorage implements StorageDriver {
  constructor(
    private readonly inner: StorageDriver,
    private readonly cipher: ContentCipher,
  ) {}

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    if (!this.cipher.enabled) return this.inner.put(key, data, contentType);
    await this.inner.put(key, this.cipher.encryptBuffer(data), ENCRYPTED_CONTENT_TYPE);
  }

  async get(key: string): Promise<Buffer | null> {
    const data = await this.inner.get(key);
    return data === null ? null : this.cipher.decryptBuffer(data);
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }
}
