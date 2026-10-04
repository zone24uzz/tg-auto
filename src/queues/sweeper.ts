import type { MessageRepository } from '../messages/message.repository.js';
import type { PgQueue } from './pg-queue.js';

/** Incoming messages still QUEUED this long after arrival without a live job are considered orphaned. */
export const ORPHAN_AGE_MS = 2 * 60_000;
const SWEEP_BUCKET_MS = 5 * 60_000;

/**
 * Safety net for messages that would otherwise stay QUEUED forever (crash between storing and
 * enqueueing, a job that exited early, a lost media job…): re-enqueues the newest pending message
 * of every chat that has no QUEUED/RUNNING `message.process` job. Its job answers the whole burst.
 * Deduplicated per time bucket, so several processes running the scheduler don't double-enqueue.
 */
export async function sweepOrphanedMessages(
  deps: { repo: MessageRepository; queue: PgQueue },
  opts: { olderThanMs?: number; limit?: number; now?: Date } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const orphans = await deps.repo.orphanedPendingMessages(new Date(now.getTime() - (opts.olderThanMs ?? ORPHAN_AGE_MS)), opts.limit ?? 100);
  const bucket = Math.floor(now.getTime() / SWEEP_BUCKET_MS);
  let enqueued = 0;
  for (const o of orphans) {
    const id = await deps.queue.enqueue(
      o.hasPendingMedia ? 'media' : 'text',
      'message.process',
      { messageId: o.id },
      { dedupeKey: `msg:${o.id}:sweep:${bucket}`, maxAttempts: 3 },
    );
    if (id !== null) enqueued++;
  }
  return enqueued;
}
