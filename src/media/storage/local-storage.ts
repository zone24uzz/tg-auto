import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertInside } from '../../security/files.js';
import { validateStorageKey, type StorageDriver } from './storage.js';

/** Stores objects as files under `rootDir` (keys validated, paths confined to the root). */
export class LocalStorage implements StorageDriver {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  private resolve(key: string): string {
    validateStorageKey(key);
    const full = path.resolve(this.root, ...key.split('/'));
    assertInside(this.root, full);
    return full;
  }

  async put(key: string, data: Buffer, _contentType: string): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    // Write to a sibling temp file first so readers never see a partial object.
    const tmp = `${full}.${randomUUID()}.part`;
    try {
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, full);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    const full = this.resolve(key);
    try {
      return await readFile(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const full = this.resolve(key);
    await rm(full, { force: true });
  }
}
