import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/database/client.js';
import { cleanupExpiredMedia, sweepTempDir } from '../../src/media/cleanup.js';
import type { StorageDriver } from '../../src/media/storage/storage.js';
import { makeTmpDir, removeDir } from './helpers.js';

const NOW = new Date('2026-10-04T12:00:00.000Z');

interface Row {
  id: number;
  storageKey: string | null;
  expiresAt: Date | null;
  deletedAt: Date | null;
}

function fakeDb(rows: Row[]) {
  const db = {
    media: {
      findMany: vi.fn(
        async (args: {
          where: { expiresAt: { lt: Date }; id: { gt: number } };
          take: number;
        }) =>
          rows
            .filter(
              (r) =>
                r.storageKey !== null &&
                r.expiresAt !== null &&
                r.expiresAt < args.where.expiresAt.lt &&
                r.id > args.where.id.gt,
            )
            .sort((a, b) => a.id - b.id)
            .slice(0, args.take)
            .map((r) => ({ id: r.id, storageKey: r.storageKey })),
      ),
      update: vi.fn(async ({ where, data }: { where: { id: number }; data: Partial<Row> }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
  };
  return db as unknown as Db;
}

describe('cleanupExpiredMedia', () => {
  it('deletes expired objects, clears storageKey and counts failures (retried next run)', async () => {
    const past = new Date(NOW.getTime() - 1000);
    const future = new Date(NOW.getTime() + 86_400_000);
    const rows: Row[] = [
      { id: 1, storageKey: 'media/1/1.jpg', expiresAt: past, deletedAt: null },
      { id: 2, storageKey: 'media/1/2.ogg', expiresAt: past, deletedAt: null },
      { id: 3, storageKey: 'media/2/3.pdf', expiresAt: future, deletedAt: null },
      { id: 4, storageKey: null, expiresAt: past, deletedAt: null },
      { id: 5, storageKey: 'media/3/5.mp4', expiresAt: past, deletedAt: null },
    ];
    const deleteFn = vi.fn(async (key: string) => {
      if (key === 'media/1/2.ogg') throw new Error('storage unavailable');
    });
    const storage: StorageDriver = { put: vi.fn(), get: vi.fn(async () => null), delete: deleteFn };

    const result = await cleanupExpiredMedia({ db: fakeDb(rows), storage, now: NOW, batchSize: 2 });

    expect(result).toEqual({ deleted: 2, failed: 1 });
    expect(deleteFn.mock.calls.map((c) => c[0])).toEqual(['media/1/1.jpg', 'media/1/2.ogg', 'media/3/5.mp4']);
    expect(rows[0]).toMatchObject({ storageKey: null, deletedAt: NOW });
    expect(rows[1]).toMatchObject({ storageKey: 'media/1/2.ogg', deletedAt: null });
    expect(rows[2]).toMatchObject({ storageKey: 'media/2/3.pdf', deletedAt: null });
    expect(rows[4]).toMatchObject({ storageKey: null, deletedAt: NOW });
  });

  it('does nothing when nothing expired', async () => {
    const storage: StorageDriver = { put: vi.fn(), get: vi.fn(async () => null), delete: vi.fn() };
    expect(await cleanupExpiredMedia({ db: fakeDb([]), storage, now: NOW })).toEqual({ deleted: 0, failed: 0 });
    expect(storage.delete).not.toHaveBeenCalled();
  });
});

describe('sweepTempDir', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmpDir('sweep-');
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it('removes only regular files older than the threshold (non-recursive)', async () => {
    const now = Date.now();
    const old = path.join(dir, 'old.bin');
    const fresh = path.join(dir, 'fresh.bin');
    const sub = path.join(dir, 'nested');
    await writeFile(old, 'x');
    await writeFile(fresh, 'y');
    await mkdir(sub);
    await writeFile(path.join(sub, 'old-inside.bin'), 'z');
    const twoHoursAgo = new Date(now - 2 * 3_600_000);
    await utimes(old, twoHoursAgo, twoHoursAgo);
    await utimes(path.join(sub, 'old-inside.bin'), twoHoursAgo, twoHoursAgo);

    const result = await sweepTempDir(dir, 3_600_000, now);

    expect(result).toEqual({ removed: 1, errors: 0 });
    expect((await readdir(dir)).sort()).toEqual(['fresh.bin', 'nested']);
    expect(await readdir(sub)).toEqual(['old-inside.bin']);
  });

  it('treats a missing directory as empty', async () => {
    expect(await sweepTempDir(path.join(dir, 'does-not-exist'), 1000)).toEqual({ removed: 0, errors: 0 });
  });
});
