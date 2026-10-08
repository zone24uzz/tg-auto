import type { Job } from '../generated/prisma/client.js';
import type { EventLog } from '../logging/events.js';
import { childLogger } from '../logging/logger.js';
import { describeError } from '../logging/sanitize.js';
import type { PgQueue } from '../queues/pg-queue.js';
import { sweepOrphanedMessages } from '../queues/sweeper.js';
import { OPEN_SETUP_TTL_MS } from '../onboarding/onboarding.js';
import { currentTenant, runAsSystem } from '../tenancy/context.js';
import { currentTenantId } from '../tenancy/context.js';
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
    'assistant.remind': async (job: Job) => {
      await c.assistant.runReminder(num(job.payload, 'taskId'));
    },
    'attention.ai': async (job: Job) => {
      await runOwnerApprovedAi(
        { pipeline: c.pipeline, notifier: c.notifier, queue: c.queue, adminTelegramUserId: currentTenant('attention.ai').ownerTelegramUserId },
        job,
      );
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
    jobScope(c),
  );
}

/**
 * The tenant a job belongs to: `__tenantId` stamped at enqueue time, or — for jobs enqueued by
 * system sweeps or before multi-tenancy — derived from the row the job points at. null = system job.
 */
export async function tenantIdOfJob(db: Container['db'], job: Pick<Job, 'type' | 'payload'>): Promise<number | null> {
  const p = (job.payload ?? {}) as Record<string, unknown>;
  if (typeof p.__tenantId === 'number' && Number.isInteger(p.__tenantId)) return p.__tenantId;
  const id = (key: string): number | null => (typeof p[key] === 'number' && Number.isInteger(p[key]) ? (p[key] as number) : null);
  return runAsSystem(async () => {
    switch (job.type) {
      case 'message.process': {
        const messageId = id('messageId');
        return messageId === null ? null : ((await db.message.findUnique({ where: { id: messageId }, select: { tenantId: true } }))?.tenantId ?? null);
      }
      case 'summary.update': {
        const chatId = id('chatId');
        return chatId === null ? null : ((await db.chat.findUnique({ where: { id: chatId }, select: { tenantId: true } }))?.tenantId ?? null);
      }
      case 'attention.ai': {
        const attentionId = id('attentionId');
        return attentionId === null
          ? null
          : ((await db.ownerAttention.findUnique({ where: { id: attentionId }, select: { tenantId: true } }))?.tenantId ?? null);
      }
      case 'assistant.remind': {
        const taskId = id('taskId');
        return taskId === null ? null : ((await db.assistantTask.findUnique({ where: { id: taskId }, select: { tenantId: true } }))?.tenantId ?? null);
      }
      default:
        return null;
    }
  });
}

/** Job types that always belong to a workspace (they must never run in system scope). */
const TENANT_JOB_TYPES = new Set(['message.process', 'summary.update', 'attention.ai', 'assistant.remind']);

/**
 * Runs a job in its tenant's scope. Jobs of a workspace that is no longer active (revoked) or no longer
 * exists — and workspace jobs whose tenant cannot be determined — are completed without running, so
 * nothing is sent on behalf of a revoked owner. Only true system jobs run in system scope.
 */
export function jobScope(c: Pick<Container, 'db' | 'tenants' | 'queue'>): (job: Job, fn: () => Promise<void>) => Promise<void> {
  return async (job, fn) => {
    const tenantId = await tenantIdOfJob(c.db, job);
    if (tenantId === null) {
      if (TENANT_JOB_TYPES.has(job.type)) {
        log.warn({ jobId: job.id, type: job.type }, 'workspace job without a resolvable tenant skipped');
        await c.queue.complete(job.id);
        return;
      }
      await runAsSystem(fn);
      return;
    }
    const tenant = await c.tenants.byId(tenantId);
    if (!tenant || tenant.status !== 'ACTIVE') {
      log.warn({ jobId: job.id, tenantId, status: tenant?.status ?? 'missing' }, 'job of an inactive workspace skipped');
      await c.queue.complete(job.id);
      return;
    }
    await c.tenants.run(tenant, fn);
  };
}

/** Clears the current tenant's expired pause exactly once across processes; true when this caller cleared it. */
async function clearExpiredPause(c: Container, pausedUntil: string): Promise<boolean> {
  const tenantId = currentTenantId('pause');
  const changed = await c.db.$executeRaw`
    UPDATE settings SET value = 'null'::jsonb, "updatedAt" = now()
     WHERE "tenantId" = ${tenantId} AND key = 'pausedUntil' AND value = ${JSON.stringify(pausedUntil)}::jsonb`;
  c.settings.invalidate();
  return changed === 1;
}

/** One tenant's periodic work: expire its pause, run its assistant, schedule its daily retention cleanup. */
async function tenantTick(c: Container): Promise<void> {
  // Fresh values: another process (admin bot) may have changed the pause a moment ago.
  c.settings.invalidate();
  const settings = await c.settings.get();
  if (settings.pausedUntil && new Date(settings.pausedUntil).getTime() <= Date.now()) {
    if (await clearExpiredPause(c, settings.pausedUntil)) await c.notifier.text('▶️ Pauza tugadi — avtojavob yana ishlayapti.');
  }
  // Owner's assistant: presence polling for "tell me when X is online" + stale draft cleanup.
  await c.assistant.tick().catch((error: unknown) => log.warn({ err: error }, 'assistant tick failed'));
  const last = settings.lastCleanupAt ? new Date(settings.lastCleanupAt).getTime() : 0;
  if (Date.now() - last > 24 * 3_600_000) {
    const day = new Date().toISOString().slice(0, 10);
    await c.queue.enqueue('maintenance', 'maintenance.cleanup', {}, { dedupeKey: `cleanup:${currentTenant().tenantId}:${day}`, maxAttempts: 2 });
  }
}

/**
 * Periodic housekeeping: recover jobs of crashed workers (dead-lettering exhausted ones),
 * re-enqueue orphaned messages, expire pauses, and enqueue the daily retention cleanup
 * (deduplicated per day so several processes don't double-run it).
 */
export function startScheduler(c: Container): () => void {
  const scope = jobScope(c);
  const tick = async () => {
    try {
      await runAsSystem(async () => {
        const recovered = await c.queue.recoverStale(undefined, (job) =>
          scope(job, () => onJobDead({ pipeline: c.pipeline, events: c.events }, job, job.lastError ?? 'worker stopped responding')),
        );
        if (recovered > 0) log.warn({ recovered }, 'recovered stale jobs');
        const swept = await sweepOrphanedMessages({ repo: c.repo, queue: c.queue });
        if (swept > 0) log.warn({ swept }, 're-enqueued orphaned messages');
        // Sign-ups abandoned before submitting (tenants is a global table).
        const expired = await c.db.tenant.deleteMany({
          where: { status: 'PENDING', onboardingStep: { not: null }, updatedAt: { lt: new Date(Date.now() - OPEN_SETUP_TTL_MS) } },
        });
        if (expired.count > 0) c.tenants.invalidate();
      });
    } catch (error) {
      log.error({ err: error }, 'scheduler tick failed');
    }
    let tenants: Awaited<ReturnType<typeof c.tenants.listActive>> = [];
    try {
      tenants = await c.tenants.listActive();
    } catch (error) {
      log.error({ err: error }, 'could not list tenants');
    }
    for (const tenant of tenants) {
      try {
        await c.tenants.run(tenant, () => tenantTick(c));
      } catch (error) {
        log.error({ err: error, tenantId: tenant.id }, 'tenant scheduler tick failed');
      }
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), SCHEDULER_TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
