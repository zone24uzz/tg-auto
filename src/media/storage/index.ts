import type { Env } from '../../config/env.js';
import { LocalStorage } from './local-storage.js';
import { S3Storage } from './s3-storage.js';
import type { StorageDriver } from './storage.js';

export type { StorageDriver } from './storage.js';
export { InvalidStorageKeyError, mediaStorageKey, validateStorageKey } from './storage.js';
export { LocalStorage } from './local-storage.js';
export { EncryptedStorage, ENCRYPTED_CONTENT_TYPE } from './encrypted-storage.js';
export { S3Storage, S3StorageError } from './s3-storage.js';

export type StorageEnv = Pick<
  Env,
  'STORAGE_DRIVER' | 'STORAGE_LOCAL_DIR' | 'S3_ENDPOINT' | 'S3_REGION' | 'S3_BUCKET' | 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY'
>;

export function createStorage(env: StorageEnv): StorageDriver {
  if (env.STORAGE_DRIVER === 's3') {
    const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
    if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
      throw new Error('STORAGE_DRIVER=s3 requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
    }
    return new S3Storage({
      endpoint: S3_ENDPOINT,
      bucket: S3_BUCKET,
      region: env.S3_REGION,
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
    });
  }
  return new LocalStorage(env.STORAGE_LOCAL_DIR);
}
