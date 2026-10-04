import type { Job } from '../generated/prisma/client.js';
import type { EventLog } from '../logging/events.js';
import { childLogger } from '../logging/logger.js';
import { describeError } from '../logging/sanitize.js';
import type { PgQueue } from '../queues/pg-queue.js';
import { sweepOrphanedMessages } from '../queues/sweeper.js';
import { PipelineRetryLater, type OwnerAiOutcome, type ReplyPipeline } from '../responder/pipeline.js';
import type { AdminNotifier } from '../telegram/admin/notifier.js';
import { RetryLaterError, WorkerRunner, type JobHandler } from '../workers/worker-runner.js';
import type { Container } from './container.js';

const log = childLogger('jobs');
const SCHEDULER_TICK_MS = 60_000;

function num(payload: unknown, key: string): number {
  const v = (payload as Record<string, unknown> | null)?.[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`invalid job payload: ${key}`);
  return v;
}

const OWNER_AI_TEXT: Record<OwnerAiOutcome, string> = {
  sent: '🤖 AI javob yubordi.',
  resolved: 'ℹ️ Bu xabar allaqachon hal qilingan.',
  uncertain:
    '⚠️ Avvalgi javob mijozga yetib borgan bo‘lishi mumkin (Telegram natijani tasdiqlamadi), shuning uchun AI qayta yubormadi. Chatni tekshiring va kerak bo‘lsa o‘zingiz javob bering.',
  failed: '❌ AI javob bera olmadi (xatolik yoki xavfsizlik filtri). Qayta urinib ko‘ring yoki o‘zingiz javob bering.',
};

/**
 * "🤖 Let AI reply" job. Never fails the job (the owner is told the outcome instead), and releases
 * the job's dedupe key when finished so the owner can press the button again after a failure.
 */
export async function runOwnerApprovedAi(
  deps: { pipeline: Pick<ReplyPipeline, 'ownerApprovedAiReply'>; notifier: Pick<AdminNotifier, 'text'>; queue: Pick<PgQueue, 'releaseDedupeKey'>; adminTelegramUserId: bigint },
  job: Job,
): Promise<OwnerAiOutcome> {
  let outcome: OwnerAiOutcome;
  try {
    outcome = await deps.pipeline.ownerApprovedAiReply(num(job.payload, 'attentionId'), deps.adminTelegramUserId);
  } catch (error) {
    if (error instanceof PipelineRetryLater) throw new RetryLaterError(error.delayMs); // chat busy: keep the job (and its key)
    log.error({ jobId: job.id, error: describeError(error) }, 'owner-approved AI reply crashed');
    outcome = 'failed';
  }
  await deps.queue.releaseDedupeKey(job.id).catch((error: unknown) => log.warn({ jobId: job.id, error: describeError(error) }, 'could not release dedupe key'));
  await deps.notifier.text(OWNER_AI_TEXT[outcome]);
  return outcome;
}

/** A job used up its attempts: log it, and hand an unanswerable message to the owner. */
export async function onJobDead(
  deps: { pipeline: Pick<ReplyPipeline, 'handleDeadMessageJob'>; events: Pick<EventLog, 'error'> },
  job: Job,
  error: string,
): Promise<void> {
  await deps.events.error('worker', `job ${job.type}#${job.id} dead after ${job.attempts} attempts: ${error}`);
  if (job.type !== 'message.process') return;
  let messageId: number;
  try {
    messageId = num(job.payload, 'messageId');
  } catch {
    return;
  }
  try {
    await deps.pipeline.handleDeadMessageJob(messageId, error);
  } catch (hookError) {
    log.error({ jobId: job.id, error: describeError(hookError) }, 'could not hand a dead message job to the owner');
  }
}

/** Job type → handler. Payloads only carry ids; everything else is read from the DB. */
export function buildJobHandlers(c: Container): Record<string, JobHandler> {
  return {
    'message.process': async (job: Job) => {
      try {
        await c.pipeline.processMessage(num(job.payload, 'messageId'), job.queue as 'text' | 'media');
      } catch (error) {
        if (error instanceof PipelineRetryLater) throw new RetryLaterError(error.delayMs);
        throw error;
      }
    },
    'summary.update': async (job: Job) => {
      await c.summaries.update(num(job.payload, 'chatId'), await c.settings.get());
    },
    'attention.ai': async (job: Job) => {
      await runOwnerApprovedAi({ pipeline: c.pipeline, notifier: c.notifier, queue: c.queue, adminTelegramUserId: c.env.ADMIN_TELEGRAM_USER_ID }, job);
    },
    'maintenance.cleanup': async () => {
      const settings = await c.settings.get();
      await c.cleanup.run(settings);
      await c.settings.set('lastCleanupAt', new Date().toISOString());
    },
  };
}

export function buildWorker(c: Container): WorkerRunner {
  return new WorkerRunner(
    c.queue,
    [
      { name: 'text', concurrency: c.env.WORKER_CONCURRENCY_TEXT, pollMs: 1_000 },
      { name: 'media', concurrency: c.env.WORKER_CONCURRENCY_MEDIA, pollMs: 2_000 },
      { name: 'maintenance', concurrency: 1, pollMs: 15_000 },
    ],
    buildJobHandlers(c),
    async (job, error, dead) => {
      if (dead) await onJobDead({ pipeline: c.pipeline, events: c.events }, job, error);
    },
  );
}

/** Clears an expired pause exactly once across processes; true when this caller cleared it. */
async function clearExpiredPause(c: Container, pausedUntil: string): Promise<boolean> {
  const changed = await c.db.$executeRaw`
    UPDATE settings SET value = 'null'::jsonb, "updatedAt" = now()
     WHERE key = 'pausedUntil' AND value = ${JSON.stringify(pausedUntil)}::jsonb`;
  c.settings.invalidate();
  return changed === 1;
}

/**
 * Periodic housekeeping: recover jobs of crashed workers (dead-lettering exhausted ones),
 * re-enqueue orphaned messages, expire pauses, and enqueue the daily retention cleanup
 * (deduplicated per day so several processes don't double-run it).
 */
export function startScheduler(c: Container): () => void {
  const tick = async () => {
    try {
      const recovered = await c.queue.recoverStale(undefined, (job) =>
        onJobDead({ pipeline: c.pipeline, events: c.events }, job, job.lastError ?? 'worker stopped responding'),
      );
      if (recovered > 0) log.warn({ recovered }, 'recovered stale jobs');
      const swept = await sweepOrphanedMessages({ repo: c.repo, queue: c.queue });
      if (swept > 0) log.warn({ swept }, 're-enqueued orphaned messages');
      // Fresh values: another process (admin bot) may have changed the pause a moment ago.
      c.settings.invalidate();
      const settings = await c.settings.get();
      if (settings.pausedUntil && new Date(settings.pausedUntil).getTime() <= Date.now()) {
        if (await clearExpiredPause(c, settings.pausedUntil)) await c.notifier.text('▶️ Pauza tugadi — avtojavob yana ishlayapti.');
      }
      const last = settings.lastCleanupAt ? new Date(settings.lastCleanupAt).getTime() : 0;
      if (Date.now() - last > 24 * 3_600_000) {
        const day = new Date().toISOString().slice(0, 10);
        await c.queue.enqueue('maintenance', 'maintenance.cleanup', {}, { dedupeKey: `cleanup:${day}`, maxAttempts: 2 });
      }
    } catch (error) {
      log.error({ err: error }, 'scheduler tick failed');
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), SCHEDULER_TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
