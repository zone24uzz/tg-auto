import { hostname } from 'node:os';
import type { Job } from '../generated/prisma/client.js';
import { childLogger } from '../logging/logger.js';
import { describeError } from '../logging/sanitize.js';
import type { PgQueue, QueueName } from '../queues/pg-queue.js';

const log = childLogger('worker');
/** How often a running job refreshes `lockedAt` (recoverStale treats 10 min without it as a crash). */
export const JOB_HEARTBEAT_MS = 60_000;

export type JobHandler = (job: Job) => Promise<void>;

/** Thrown by handlers to re-run a job later without counting it as a failure. */
export class RetryLaterError extends Error {
  constructor(public readonly delayMs: number) {
    super('retry later');
  }
}

export interface QueueConfig {
  name: QueueName;
  concurrency: number;
  pollMs: number;
}

/**
 * Polls the PostgreSQL queue with per-queue concurrency, so heavy media jobs never block
 * the fast text queue. Wakes up immediately on in-process enqueue.
 */
export class WorkerRunner {
  private readonly workerId = `${hostname()}:${process.pid}`;
  private running = false;
  private active = new Map<QueueName, number>();
  private timers: NodeJS.Timeout[] = [];
  private inflight = new Set<Promise<void>>();
  private unsubscribe?: () => void;

  constructor(
    private readonly queue: PgQueue,
    private readonly queues: QueueConfig[],
    private readonly handlers: Record<string, JobHandler>,
    private readonly onJobError?: (job: Job, error: string, dead: boolean) => Promise<void>,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const q of this.queues) {
      this.active.set(q.name, 0);
      const timer = setInterval(() => void this.tick(q), q.pollMs);
      this.timers.push(timer);
      void this.tick(q);
    }
    this.unsubscribe = this.queue.onEnqueue((name) => {
      const q = this.queues.find((c) => c.name === name);
      if (q) void this.tick(q);
    });
    log.info({ workerId: this.workerId, queues: this.queues.map((q) => `${q.name}×${q.concurrency}`) }, 'worker started');
  }

  async stop(timeoutMs = 20_000): Promise<void> {
    this.running = false;
    this.unsubscribe?.();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const all = Promise.allSettled([...this.inflight]);
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
    log.info('worker stopped');
  }

  private ticking = new Set<QueueName>();

  private async tick(q: QueueConfig): Promise<void> {
    if (!this.running || this.ticking.has(q.name)) return;
    this.ticking.add(q.name);
    try {
      const free = q.concurrency - (this.active.get(q.name) ?? 0);
      if (free <= 0) return;
      const jobs = await this.queue.claim(q.name, this.workerId, free);
      for (const job of jobs) {
        this.active.set(q.name, (this.active.get(q.name) ?? 0) + 1);
        const p = this.run(job).finally(() => {
          this.active.set(q.name, (this.active.get(q.name) ?? 1) - 1);
          this.inflight.delete(p);
          if (this.running) void this.tick(q);
        });
        this.inflight.add(p);
      }
    } catch (error) {
      log.error({ error: describeError(error), queue: q.name }, 'queue poll failed');
    } finally {
      this.ticking.delete(q.name);
    }
  }

  private async run(job: Job): Promise<void> {
    const handler = this.handlers[job.type];
    if (!handler) {
      await this.queue.fail(job, `no handler for ${job.type}`, false);
      return;
    }
    // Long handlers (AI calls, media, reply delays) keep their lock fresh so recoverStale
    // never hands a live job to another worker.
    const heartbeat = setInterval(() => {
      this.queue.heartbeat(job.id, this.workerId).catch((error: unknown) => log.warn({ jobId: job.id, error: describeError(error) }, 'job heartbeat failed'));
    }, JOB_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      await handler(job);
      clearInterval(heartbeat);
      await this.queue.complete(job.id);
    } catch (error) {
      clearInterval(heartbeat);
      if (error instanceof RetryLaterError) {
        await this.queue.reschedule(job.id, error.delayMs);
        return;
      }
      const desc = describeError(error);
      const outcome = await this.queue.fail(job, desc, true);
      log.error({ jobId: job.id, type: job.type, error: desc, outcome }, 'job failed');
      try {
        await this.onJobError?.(job, desc, outcome === 'dead');
      } catch (hookError) {
        log.error({ jobId: job.id, error: describeError(hookError) }, 'job error hook failed');
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
}
