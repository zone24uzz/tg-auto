import type { Db } from '../database/client.js';
import type { Job } from '../generated/prisma/client.js';
import type { Prisma } from '../generated/prisma/client.js';
import { isUniqueViolation } from '../messages/message.repository.js';

export type QueueName = 'text' | 'media' | 'maintenance';

export interface EnqueueOptions {
  runAt?: Date;
  /** Unique key; a second enqueue with the same key is ignored (idempotency). */
  dedupeKey?: string;
  maxAttempts?: number;
}

type Listener = (queue: QueueName) => void;

/**
 * Durable job queue on PostgreSQL using FOR UPDATE SKIP LOCKED.
 * Chosen over Redis/BullMQ to avoid extra infrastructure: jobs survive restarts and
 * several worker processes can share the table safely.
 */
export class PgQueue {
  private listeners = new Set<Listener>();

  constructor(private readonly db: Db) {}

  /** In-process wake-up so the embedded worker does not wait for the next poll. */
  onEnqueue(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async enqueue(queue: QueueName, type: string, payload: Prisma.InputJsonValue, opts: EnqueueOptions = {}): Promise<number | null> {
    try {
      const job = await this.db.job.create({
        data: {
          queue,
          type,
          payload,
          runAt: opts.runAt ?? new Date(),
          dedupeKey: opts.dedupeKey ?? null,
          maxAttempts: opts.maxAttempts ?? 3,
        },
      });
      const delay = (opts.runAt?.getTime() ?? 0) - Date.now();
      if (delay <= 0) this.listeners.forEach((l) => l(queue));
      else setTimeout(() => this.listeners.forEach((l) => l(queue)), Math.min(delay + 25, 2_147_000_000)).unref();
      return job.id;
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  /** Atomically claims up to `limit` due jobs of a queue. */
  async claim(queue: QueueName, workerId: string, limit: number): Promise<Job[]> {
    if (limit <= 0) return [];
    return this.db.$queryRaw<Job[]>`
      UPDATE jobs
         SET status = 'RUNNING', "lockedAt" = now(), "lockedBy" = ${workerId},
             attempts = attempts + 1, "updatedAt" = now()
       WHERE id IN (
         SELECT id FROM jobs
          WHERE queue = ${queue} AND status = 'QUEUED' AND "runAt" <= now()
          ORDER BY "runAt", id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING *`;
  }

  async complete(id: number): Promise<void> {
    await this.db.job.update({ where: { id }, data: { status: 'DONE', finishedAt: new Date(), lockedAt: null, lockedBy: null } });
  }

  /** Re-queues with exponential backoff, or marks DEAD after maxAttempts. */
  async fail(job: Pick<Job, 'id' | 'attempts' | 'maxAttempts'>, error: string, retryable = true): Promise<'retry' | 'dead'> {
    const dead = !retryable || job.attempts >= job.maxAttempts;
    const backoffMs = Math.min(5 * 60_000, 2_000 * 2 ** Math.max(0, job.attempts - 1));
    await this.db.job.update({
      where: { id: job.id },
      data: dead
        ? { status: 'DEAD', lastError: error.slice(0, 1000), finishedAt: new Date(), lockedAt: null, lockedBy: null }
        : { status: 'QUEUED', lastError: error.slice(0, 1000), runAt: new Date(Date.now() + backoffMs), lockedAt: null, lockedBy: null },
    });
    return dead ? 'dead' : 'retry';
  }

  /** Puts a claimed job back without counting the attempt (e.g. the chat is busy). */
  async reschedule(id: number, delayMs: number): Promise<void> {
    await this.db.job.update({
      where: { id },
      data: {
        status: 'QUEUED',
        runAt: new Date(Date.now() + delayMs),
        attempts: { decrement: 1 },
        lockedAt: null,
        lockedBy: null,
      },
    });
    setTimeout(() => this.listeners.forEach((l) => l('text')), delayMs + 25).unref();
  }

  /** Keeps a long-running job's lock fresh so recoverStale does not hand it to another worker. */
  async heartbeat(id: number, workerId: string): Promise<boolean> {
    const result = await this.db.job.updateMany({
      where: { id, status: 'RUNNING', lockedBy: workerId },
      data: { lockedAt: new Date() },
    });
    return result.count === 1;
  }

  /**
   * Jobs left RUNNING by a crashed process (no heartbeat for `olderThanMs`) go back to the queue,
   * or become DEAD when they already used all attempts. `onDead` runs for each newly dead job.
   */
  async recoverStale(olderThanMs = 10 * 60_000, onDead?: (job: Job) => Promise<void>): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const dead = await this.db.$queryRaw<Job[]>`
      UPDATE jobs
         SET status = 'DEAD', "lastError" = left(coalesce("lastError" || ' | ', '') || 'worker stopped responding (stale lock)', 1000),
             "finishedAt" = now(), "lockedAt" = NULL, "lockedBy" = NULL, "updatedAt" = now()
       WHERE status = 'RUNNING' AND "lockedAt" < ${cutoff} AND attempts >= "maxAttempts"
      RETURNING *`;
    const requeued = await this.db.job.updateMany({
      where: { status: 'RUNNING', lockedAt: { lt: cutoff } },
      data: { status: 'QUEUED', lockedAt: null, lockedBy: null },
    });
    if (requeued.count > 0) this.listeners.forEach((l) => l('text'));
    if (onDead) for (const job of dead) await onDead(job);
    return requeued.count + dead.length;
  }

  /** Removes a finished job's dedupe key so the same action can be enqueued again (e.g. a retry by the owner). */
  async releaseDedupeKey(id: number): Promise<void> {
    await this.db.job.updateMany({ where: { id }, data: { dedupeKey: null } });
  }

  async purgeFinished(olderThan: Date): Promise<number> {
    const result = await this.db.job.deleteMany({
      where: { status: { in: ['DONE', 'DEAD'] }, updatedAt: { lt: olderThan } },
    });
    return result.count;
  }

  async stats(): Promise<Record<string, number>> {
    const rows = await this.db.job.groupBy({ by: ['status'], _count: { _all: true } });
    return Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
  }
}
