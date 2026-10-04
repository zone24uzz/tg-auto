import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../database/client.js';
import { childLogger } from '../logging/logger.js';
import { describeError } from '../logging/sanitize.js';
import type { StorageDriver } from './storage/storage.js';

const log = childLogger('media.cleanup');

export interface CleanupExpiredResult {
  /** Objects deleted from storage (rows updated). */
  deleted: number;
  /** Rows whose object could not be deleted (retried on the next run). */
  failed: number;
}

/**
 * Deletes retained raw media whose retention expired: removes the storage object,
 * then clears `storageKey` and sets `deletedAt`. Analysis results stay.
 */
export async function cleanupExpiredMedia(opts: {
  db: Db;
  storage: StorageDriver;
  now?: Date;
  batchSize?: number;
  /** Safety valve per run. */
  maxRows?: number;
}): Promise<CleanupExpiredResult> {
  const now = opts.now ?? new Date();
  const batchSize = Math.max(1, opts.batchSize ?? 200);
  const maxRows = Math.max(batchSize, opts.maxRows ?? 10_000);
  let deleted = 0;
  let failed = 0;
  let cursor = 0;
  let seen = 0;

  while (seen < maxRows) {
    const rows = await opts.db.media.findMany({
      where: { expiresAt: { lt: now }, storageKey: { not: null }, id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: batchSize,
      select: { id: true, storageKey: true },
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      cursor = row.id;
      seen++;
      if (!row.storageKey) continue;
      try {
        await opts.storage.delete(row.storageKey);
        await opts.db.media.update({ where: { id: row.id }, data: { storageKey: null, deletedAt: now } });
        deleted++;
      } catch (error) {
        failed++;
        log.warn({ err: describeError(error), mediaId: row.id }, 'failed to delete expired media object');
      }
    }
    if (rows.length < batchSize) break;
  }
  if (deleted || failed) log.info({ deleted, failed }, 'expired raw media cleaned up');
  return { deleted, failed };
}

export interface SweepResult {
  removed: number;
  errors: number;
}

/** Removes regular files in `tmpDir` (non-recursive, symlinks are not followed) older than `olderThanMs`. */
export async function sweepTempDir(tmpDir: string, olderThanMs: number, now = Date.now()): Promise<SweepResult> {
  const root = path.resolve(tmpDir);
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!entries) return { removed: 0, errors: 0 };
  let removed = 0;
  let errors = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(root, entry.name);
    try {
      const info = await lstat(full);
      if (!info.isFile()) continue;
      if (now - info.mtimeMs < olderThanMs) continue;
      await rm(full, { force: true });
      removed++;
    } catch {
      errors++;
    }
  }
  if (removed || errors) log.info({ removed, errors }, 'temp media files swept');
  return { removed, errors };
}
