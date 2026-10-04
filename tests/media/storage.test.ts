import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ENCRYPTED_CONTENT_TYPE,
  EncryptedStorage,
  InvalidStorageKeyError,
  LocalStorage,
  S3Storage,
  S3StorageError,
  createStorage,
  mediaStorageKey,
  validateStorageKey,
} from '../../src/media/storage/index.js';
import { ContentCipher, DecryptionError } from '../../src/security/crypto.js';
import { makeTmpDir, removeDir } from './helpers.js';

describe('storage keys', () => {
  it('accepts normal keys', () => {
    expect(validateStorageKey('media/12/34.jpg')).toBe('media/12/34.jpg');
    expect(mediaStorageKey(12, 34, 'ogg')).toBe('media/12/34.ogg');
    expect(mediaStorageKey(1, 2, '../x')).toBe('media/1/2.bin');
  });

  it('rejects traversal, absolute paths and illegal characters', () => {
    for (const bad of [
      '',
      '..',
      '../etc/passwd',
      'media/../../x',
      'a/./b',
      '/abs/path',
      'trailing/',
      'a//b',
      'a\\b',
      'C:\\x',
      'with space',
      'emoji😀',
      'x'.repeat(600),
    ]) {
      expect(() => validateStorageKey(bad), JSON.stringify(bad)).toThrow(InvalidStorageKeyError);
    }
  });
});

describe('LocalStorage', () => {
  let root: string;
  let outside: string;
  beforeEach(async () => {
    outside = await makeTmpDir('storage-outer-');
    root = path.join(outside, 'root');
  });
  afterEach(async () => {
    await removeDir(outside);
  });

  it('round-trips objects and treats missing ones as null', async () => {
    const s = new LocalStorage(root);
    await s.put('media/1/2.jpg', Buffer.from('abc'), 'image/jpeg');
    expect((await s.get('media/1/2.jpg'))?.toString()).toBe('abc');
    await s.delete('media/1/2.jpg');
    expect(await s.get('media/1/2.jpg')).toBeNull();
    await s.delete('media/1/2.jpg'); // idempotent
    // no leftover .part files
    expect(await readdir(path.join(root, 'media', '1'))).toEqual([]);
  });

  it('refuses keys escaping the root and writes nothing outside', async () => {
    const s = new LocalStorage(root);
    await expect(s.put('../escape.txt', Buffer.from('x'), 'text/plain')).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(s.get('media/../../escape.txt')).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(s.delete('/etc/passwd')).rejects.toBeInstanceOf(InvalidStorageKeyError);
    expect(await readdir(outside)).toEqual([]);
  });
});

describe('S3Storage', () => {
  const secret = 'S3cr3tS3cr3tS3cr3tS3cr3tS3cr3t00';

  it('signs path-style requests and maps 404 to null', async () => {
    const calls: Request[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const req = input as Request;
      calls.push(req);
      if (req.method === 'GET') return new Response('missing', { status: 404 });
      return new Response(null, { status: 200 });
    });
    const s = new S3Storage({
      endpoint: 'https://s3.example.com/',
      bucket: 'my-bucket',
      region: 'auto',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: secret,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await s.put('media/1/2.jpg', Buffer.from('abc'), 'image/jpeg');
    expect(await s.get('media/1/2.jpg')).toBeNull();
    await s.delete('media/1/2.jpg');

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'PUT https://s3.example.com/my-bucket/media/1/2.jpg',
      'GET https://s3.example.com/my-bucket/media/1/2.jpg',
      'DELETE https://s3.example.com/my-bucket/media/1/2.jpg',
    ]);
    expect(calls[0]!.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    expect(calls[0]!.headers.get('content-type')).toBe('image/jpeg');
  });

  it('reports failures without leaking credentials', async () => {
    const fetchImpl = vi.fn(async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }));
    const s = new S3Storage({
      endpoint: 'https://s3.example.com',
      bucket: 'b-1',
      region: 'us-east-1',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: secret,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await s.put('k/1.bin', Buffer.from('x'), 'application/octet-stream').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(S3StorageError);
    expect((err as Error).message).toBe('S3 PUT failed: HTTP 403 AccessDenied');
    expect((err as Error).message).not.toContain(secret);
    await expect(s.put('../x', Buffer.from('x'), 'text/plain')).rejects.toBeInstanceOf(InvalidStorageKeyError);
  });

  it('createStorage picks the driver from env', async () => {
    const dir = await makeTmpDir();
    try {
      expect(
        createStorage({
          STORAGE_DRIVER: 'local',
          STORAGE_LOCAL_DIR: dir,
          S3_REGION: 'auto',
          S3_ENDPOINT: undefined,
          S3_BUCKET: undefined,
          S3_ACCESS_KEY_ID: undefined,
          S3_SECRET_ACCESS_KEY: undefined,
        }),
      ).toBeInstanceOf(LocalStorage);
      expect(
        createStorage({
          STORAGE_DRIVER: 's3',
          STORAGE_LOCAL_DIR: dir,
          S3_REGION: 'auto',
          S3_ENDPOINT: 'https://acc.r2.cloudflarestorage.com',
          S3_BUCKET: 'media',
          S3_ACCESS_KEY_ID: 'id',
          S3_SECRET_ACCESS_KEY: secret,
        }),
      ).toBeInstanceOf(S3Storage);
    } finally {
      await removeDir(dir);
    }
  });
});

describe('EncryptedStorage (SEC-08)', () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTmpDir('enc-store-');
  });
  afterEach(async () => {
    await removeDir(root);
  });

  const key = Buffer.alloc(32, 7).toString('base64');
  const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('private holiday photo', 'utf8')]);

  it('stores ciphertext (opaque content type) and decrypts on get', async () => {
    const inner = new LocalStorage(root);
    const putSpy = vi.spyOn(inner, 'put');
    const store = new EncryptedStorage(inner, new ContentCipher(key));
    await store.put('media/1/2.jpg', photo, 'image/jpeg');
    const [, stored, type] = putSpy.mock.calls[0]!;
    expect(type).toBe(ENCRYPTED_CONTENT_TYPE);
    expect(stored.includes(Buffer.from('private holiday photo'))).toBe(false);
    const onDisk = await inner.get('media/1/2.jpg');
    expect(ContentCipher.isEncryptedBuffer(onDisk!)).toBe(true);
    expect((await store.get('media/1/2.jpg'))!.equals(photo)).toBe(true);
    expect(await store.get('media/1/missing.jpg')).toBeNull();
    await store.delete('media/1/2.jpg');
    expect(await inner.get('media/1/2.jpg')).toBeNull();
  });

  it('reads objects stored before encryption was enabled', async () => {
    const inner = new LocalStorage(root);
    await inner.put('media/1/legacy.jpg', photo, 'image/jpeg');
    const store = new EncryptedStorage(inner, new ContentCipher(key));
    expect((await store.get('media/1/legacy.jpg'))!.equals(photo)).toBe(true);
  });

  it('is a pass-through without a key, but never returns ciphertext as plaintext', async () => {
    const inner = new LocalStorage(root);
    const putSpy = vi.spyOn(inner, 'put');
    const plain = new EncryptedStorage(inner, new ContentCipher(undefined));
    await plain.put('media/1/3.jpg', photo, 'image/jpeg');
    expect(putSpy.mock.calls[0]![2]).toBe('image/jpeg');
    expect((await inner.get('media/1/3.jpg'))!.equals(photo)).toBe(true);
    expect((await plain.get('media/1/3.jpg'))!.equals(photo)).toBe(true);

    await new EncryptedStorage(inner, new ContentCipher(key)).put('media/1/4.jpg', photo, 'image/jpeg');
    await expect(plain.get('media/1/4.jpg')).rejects.toBeInstanceOf(DecryptionError);
  });
});
