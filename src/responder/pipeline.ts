import type { AiRouter } from '../ai/router/types.js';
import { AllProvidersFailedError, type ImageInput } from '../ai/types.js';
import { isRateLimitFailure, RATE_LIMIT_RE } from '../classifiers/ai-errors.js';
import type { MessageClassifier } from '../classifiers/classifier.js';
import { buildReplyContext } from '../conversations/context-builder.js';
import type { PromptService } from '../conversations/prompt.service.js';
import type { SummaryService } from '../conversations/summary.service.js';
import type { Db } from '../database/client.js';
import type { Chat, Message, MessageStatus, MessageType, TelegramConnection, TelegramUser } from '../generated/prisma/client.js';
import type { EventLog } from '../logging/events.js';
import { childLogger } from '../logging/logger.js';
import { describeError } from '../logging/sanitize.js';
import type { MediaProcessor, MessageMediaContext } from '../media/types.js';
import type { MessageRepository } from '../messages/message.repository.js';
import type { OwnerAttentionService } from '../owner-attention/attention.service.js';
import type { PgQueue, QueueName } from '../queues/pg-queue.js';
import { decideRule } from '../rules/rules.engine.js';
import type { RulesService } from '../rules/rules.service.js';
import type { ContentCipher } from '../security/crypto.js';
import type { Settings } from '../settings/schema.js';
import { SettingsService } from '../settings/settings.service.js';
import type { UsageService } from '../statistics/usage.service.js';
import { displayUser } from '../telegram/common/html.js';
import type { AdminNotifier } from '../telegram/admin/notifier.js';
import type { TelegramSender } from '../telegram/main/sender.js';
import { localDateKey, sleep } from '../utils/time.js';
import { currentTenantId, currentTenantOrNull } from '../tenancy/context.js';
import { remainingDelayMs, targetDelayMs } from './delay.js';
import { ChatLease } from './lease.js';
import type { ReplySender, SendOutcome } from './reply-sender.js';
import { applyResponsePolicy } from './response-policy.js';

export { isRateLimitFailure } from '../classifiers/ai-errors.js';

const log = childLogger('pipeline');

const TERMINAL: ReadonlySet<MessageStatus> = new Set([
  'ANSWERED',
  'OWNER_ATTENTION',
  'MANUAL',
  'IGNORED',
  'SKIPPED',
  'RATE_LIMITED',
  'FAILED',
]);
/** Newest pending messages answered together; older pending ones of the same burst are superseded. */
export const BURST_LIMIT = 10;
const AI_RETRY_WINDOW_MS = 10 * 60_000;
const AI_RETRY_DELAY_MS = 60_000;
const CHAT_BUSY_RETRY_MS = 3_000;
/** Older messages are not auto-answered: they arrived while the assistant was offline (see handleBurst 1b). */
export const STALE_MESSAGE_MS = 30 * 60_000;
/** Low-priority owner items (rate limited / media disabled): at most one per chat per window. */
const LOW_PRIORITY_WINDOW_MINUTES = 30;
const OWNER_REPLIED = 'owner replied personally';

/** Message types whose stored text is a synthetic placeholder, not something the contact typed. */
const SYNTHETIC_TYPES: ReadonlySet<MessageType> = new Set(['STICKER', 'CONTACT', 'LOCATION', 'POLL', 'OTHER']);
const PLACEHOLDER_RE = /^\[(sticker|shared|poll|unsupported)/i;

/** Optional text-to-speech for voice replies (implemented with the AI router + ffmpeg). */
export interface VoiceSynth {
  /** OGG/Opus voice note for the text, or null when TTS is unavailable/failed. */
  toVoice(text: string, messageId: number): Promise<Buffer | null>;
}

export interface PipelineDeps {
  db: Db;
  repo: MessageRepository;
  settings: SettingsService;
  rules: RulesService;
  classifier: MessageClassifier;
  ai: AiRouter;
  media: MediaProcessor;
  prompts: PromptService;
  summaries: SummaryService;
  sender: TelegramSender;
  replies: ReplySender;
  attention: OwnerAttentionService;
  notifier: AdminNotifier;
  usage: UsageService;
  queue: PgQueue;
  events: EventLog;
  cipher: ContentCipher;
  voice?: VoiceSynth;
  timezone: string;
  adminTelegramUserId: bigint;
  /** Chat lease duration / heartbeat (defaults in lease.ts; overridable for tests). */
  leaseMs?: number;
  leaseHeartbeatMs?: number;
}

type LoadedChat = Chat & { connection: TelegramConnection; user: TelegramUser | null };

interface BurstContext {
  chat: LoadedChat;
  burst: Message[];
  last: Message;
  sender: TelegramUser | null;
  settings: Settings;
  text: string;
  media: MessageMediaContext;
  startedAt: number;
  injectionSuspected: boolean;
  /** The chat lease held while handling this burst. */
  lease: ChatLease;
  /** Set for owner-approved replies ("Let AI reply"). */
  attentionId?: number;
}

/**
 * `lease-lost`: the chat lease is no longer ours (nothing sent; retry later).
 * `superseded`: a newer incoming message joined; its own job answers the whole burst.
 */
type ReplyResult = 'sent' | 'owner' | 'failed' | 'uncertain' | 'lease-lost' | 'superseded' | 'owner-replied' | 'resolved';

/** Result of "🤖 Let AI reply". `uncertain`: a reply may already have reached the contact, nothing was re-sent. */
export type OwnerAiOutcome = 'sent' | 'failed' | 'resolved' | 'uncertain';
/** Result of an owner-typed reply. `confirm`: an earlier reply may have been delivered — resend only after explicit confirmation. */
export type ManualReplyOutcome = 'sent' | 'failed' | 'resolved' | 'uncertain' | 'confirm';

export class PipelineRetryLater extends Error {
  constructor(public readonly delayMs: number) {
    super('chat busy, retry later');
  }
}

/**
 * Message → rules → media → classification → (owner queue | AI reply) → send → log.
 * Runs inside queue workers; safe to retry (replies are claimed exactly once).
 * Every burst is handled under a per-chat lease with an owner token that is renewed while held
 * and re-checked right before anything is sent.
 */
export class ReplyPipeline {
  constructor(private readonly d: PipelineDeps) {}

  private acquireLease(chatId: number): Promise<ChatLease | null> {
    return ChatLease.acquire(this.d.db, chatId, {
      ...(this.d.leaseMs !== undefined ? { leaseMs: this.d.leaseMs } : {}),
      ...(this.d.leaseHeartbeatMs !== undefined ? { heartbeatMs: this.d.leaseHeartbeatMs } : {}),
    });
  }

  /** The owner of the workspace being served (the super-admin outside a tenant scope, e.g. in tests). */
  private ownerId(): bigint {
    return currentTenantOrNull()?.ownerTelegramUserId ?? this.d.adminTelegramUserId;
  }

  async processMessage(messageId: number, queue: QueueName): Promise<void> {
    let message = await this.d.db.message.findUnique({ where: { id: messageId } });
    if (!message || message.direction !== 'INCOMING' || TERMINAL.has(message.status)) return;
    if (message.deletedAt) {
      await this.d.db.message.updateMany({
        where: { id: message.id, status: { in: ['QUEUED', 'RECEIVED'] } },
        data: { status: 'SKIPPED', statusReason: 'deleted before reply', processedAt: new Date() },
      });
      // The newest message of a burst was deleted: answer the remaining ones instead of orphaning them.
      if (await this.d.repo.newerIncomingExists(message.chatId, message.id)) return;
      const anchor = await this.d.repo.latestPendingBefore(message.chatId, message.id);
      if (!anchor) return;
      message = anchor;
    }
    // Debounce: a newer incoming message exists → its job answers the whole burst.
    if (await this.d.repo.newerIncomingExists(message.chatId, message.id)) return;

    if (queue !== 'media') {
      const preview = await this.d.repo.pendingBurst(message.chatId, message.id, BURST_LIMIT);
      const pendingMedia =
        preview.length === 0
          ? 0
          : await this.d.db.media.count({ where: { messageId: { in: preview.map((m) => m.id) }, status: 'PENDING', kind: { not: 'STICKER' } } });
      if (pendingMedia > 0) {
        await this.enqueueMediaJob(message.id);
        return;
      }
    }

    const lease = await this.acquireLease(message.chatId);
    if (!lease) throw new PipelineRetryLater(CHAT_BUSY_RETRY_MS);
    let burst: Message[] = [];
    try {
      // We hold the lease: PROCESSING rows of this chat belong to a holder whose lease expired.
      await this.d.repo.recoverOrphanedProcessing(message.chatId);
      const fresh = await this.d.db.message.findUnique({ where: { id: message.id }, select: { status: true } });
      if (!fresh || TERMINAL.has(fresh.status)) return;
      if (await this.d.repo.newerIncomingExists(message.chatId, message.id)) return;
      burst = await this.claimBurst(message.chatId, message.id);
      if (burst.length === 0) return;
      await this.handleBurst(burst, lease);
    } catch (error) {
      // Let the queue retry: put our rows back — but only while the lease is still ours
      // (otherwise they already belong to the worker that took over).
      if (burst.length > 0 && (await lease.stillHeld().catch(() => false))) {
        await this.d.db.message.updateMany({
          where: { id: { in: burst.map((m) => m.id) }, status: 'PROCESSING' },
          data: { status: 'QUEUED' },
        });
      }
      throw error;
    } finally {
      await lease.release();
    }
  }

  /** Selects the burst (newest BURST_LIMIT pending messages incl. `uptoId`) and moves it to PROCESSING. */
  private async claimBurst(chatId: number, uptoId: number): Promise<Message[]> {
    const candidates = await this.d.repo.pendingBurst(chatId, uptoId, BURST_LIMIT);
    if (candidates.length === 0) return [];
    const ids = candidates.map((m) => m.id);
    await this.d.db.message.updateMany({
      where: { id: { in: ids }, status: { in: ['QUEUED', 'RECEIVED'] } },
      data: { status: 'PROCESSING', statusReason: null },
    });
    // Rows changed concurrently (e.g. the owner wrote → MANUAL) are no longer ours.
    const burst = await this.d.db.message.findMany({ where: { id: { in: ids }, status: 'PROCESSING' }, orderBy: { id: 'asc' } });
    if (burst.length > 0 && candidates.length >= BURST_LIMIT) {
      await this.d.repo.skipOlderPending(chatId, burst[0]!.id, uptoId, 'superseded by newer messages of the same burst');
    }
    return burst;
  }

  private async enqueueMediaJob(messageId: number): Promise<void> {
    const key = `media:${messageId}`;
    if ((await this.d.queue.enqueue('media', 'message.process', { messageId }, { dedupeKey: key })) !== null) return;
    const existing = await this.d.db.job.findUnique({ where: { dedupeKey: key }, select: { status: true } });
    if (existing && (existing.status === 'QUEUED' || existing.status === 'RUNNING')) return;
    // The earlier media job already finished (e.g. it went DEAD) → a fresh one, never a silent no-op.
    await this.d.queue.enqueue('media', 'message.process', { messageId }, { dedupeKey: `${key}:${Date.now()}` });
  }

  // ───────────────────────────── main flow ─────────────────────────────

  private async handleBurst(burst: Message[], lease: ChatLease): Promise<void> {
    const last = burst[burst.length - 1]!;
    const chat = (await this.d.db.chat.findUniqueOrThrow({
      where: { id: last.chatId },
      include: { connection: true, user: true },
    })) as LoadedChat;
    const sender = chat.user;
    const settings = await this.d.settings.get();

    // 1. The connection must belong to the admin (never trust the stored `authorized` flag alone),
    //    be enabled and allowed to reply.
    if (chat.connection.ownerUserId !== this.ownerId() || !chat.connection.isEnabled) {
      await this.setStatuses(burst, 'SKIPPED', 'connection not owned by the admin or disabled');
      return;
    }
    if (!chat.connection.canReply) {
      await this.setStatuses(burst, 'MANUAL', 'bot has no reply rights');
      return;
    }

    // 1b. Messages that waited too long (the system was offline, asleep or disconnected) get no
    //     strangely late AI answer; they go to the owner's queue instead (no waiting message).
    if (Date.now() - last.telegramDate.getTime() > STALE_MESSAGE_MS) {
      await this.setStatuses(burst, 'MANUAL', 'stale: arrived while the assistant was offline');
      await this.d.attention.create({
        messageId: last.id,
        chatId: chat.id,
        reason: 'STALE',
        detail: 'arrived while the assistant was offline',
        displayText: this.burstTexts(burst) || `[${last.type.toLowerCase()}]`,
        userLabel: labelOf(sender, chat),
        waitingMessageSent: false,
        notify: settings.notifyOwnerAttention,
        burstMessageIds: burst.map((m) => m.id),
      });
      return;
    }

    // 2. Global switch / pause.
    if (!SettingsService.isAutoReplyActive(settings)) {
      await this.setStatuses(burst, 'SKIPPED', settings.autoReplyEnabled ? 'paused' : 'auto-reply disabled');
      if (settings.notifyWhenDisabled)
        await this.d.notifier.text(`📩 Avtojavob o‘chiq paytda yangi xabar: ${escapeLabel(sender, chat)}`);
      return;
    }

    // The owner already answered personally → never auto-reply over them.
    if (await this.ownerReplied(burst)) {
      await this.setStatuses(burst, 'MANUAL', OWNER_REPLIED);
      return;
    }

    // 3. Per-user / per-chat rules.
    const rules = await this.d.rules.all();
    const decision = decideRule(settings, rules, {
      telegramUserId: sender?.telegramUserId ?? chat.telegramChatId,
      username: sender?.username,
      chatId: chat.telegramChatId,
      tags: sender?.tags ?? [],
      isNewChat: chat.lastOwnerMessageAt === null,
      isContact: sender?.isContact ?? false,
    });
    const texts = this.burstTexts(burst);
    if (decision.action === 'BLOCK' || decision.action === 'IGNORE') {
      await this.setStatuses(burst, 'IGNORED', decision.reason);
      return;
    }
    if (decision.action === 'MANUAL' || decision.action === 'VIP') {
      await this.setStatuses(burst, 'MANUAL', decision.reason);
      const notify = decision.action === 'VIP' ? settings.notifyVipMessages : settings.notifyManualMessages;
      if (notify)
        await this.d.attention.create({
          messageId: last.id,
          chatId: chat.id,
          reason: decision.action === 'VIP' ? 'VIP' : 'MANUAL',
          displayText: texts || `[${last.type.toLowerCase()}]`,
          userLabel: labelOf(sender, chat),
          waitingMessageSent: false,
          notify: true,
          burstMessageIds: burst.map((m) => m.id),
        });
      return;
    }

    const ctxBase = {
      chat,
      burst,
      last,
      sender,
      settings,
      text: texts,
      startedAt: last.createdAt.getTime(),
      injectionSuspected: false,
      lease,
    };

    // 4. Rate limits (silent: never amplify abuse with replies). The current burst does not count
    //    against its own per-minute limit; per-contact AI usage counts every AI call (media, classifier,
    //    replies…) and is checked before any paid media analysis.
    if (sender) {
      const recent = await this.d.repo.countIncomingSince(
        sender.id,
        new Date(Date.now() - 60_000),
        burst.map((m) => m.id),
      );
      if (recent > settings.maxMessagesPerMinute) {
        await this.setStatuses(burst, 'RATE_LIMITED', 'messages per minute');
        await this.lowPriorityAttention({ ...ctxBase, media: emptyMedia() }, 'RATE_LIMITED', 'messages per minute');
        return;
      }
    }
    const aiCalls = await this.d.repo.aiCallsForChatSince(chat.id, new Date(Date.now() - 3_600_000));
    if (aiCalls >= settings.maxAiRequestsPerUserPerHour) {
      await this.setStatuses(burst, 'RATE_LIMITED', 'AI requests per hour');
      await this.lowPriorityAttention({ ...ctxBase, media: emptyMedia() }, 'RATE_LIMITED', 'AI requests per hour');
      return;
    }

    // 5. Daily AI budget.
    if (settings.maxDailyAiCostUsd > 0) {
      const spent = await this.d.usage.costToday();
      if (spent >= settings.maxDailyAiCostUsd) {
        await this.notifyCostLimitOnce(settings, spent);
        await this.ownerPath({ ...ctxBase, media: emptyMedia() }, 'COST_LIMIT', `spent ≈ $${spent.toFixed(2)}`, 'fallback');
        return;
      }
    }

    // 6. Media understanding (the daily cap is re-checked right before each paid analysis).
    const processed = await this.processBurstMedia(burst, settings);
    if ('costLimitSpent' in processed) {
      await this.notifyCostLimitOnce(settings, processed.costLimitSpent);
      await this.ownerPath({ ...ctxBase, media: emptyMedia() }, 'COST_LIMIT', `spent ≈ $${processed.costLimitSpent.toFixed(2)}`, 'fallback');
      return;
    }
    const media = processed.media;
    if (media.failed && Date.now() - ctxBase.startedAt < AI_RETRY_WINDOW_MS) {
      const failed = await this.d.db.media.findMany({
        where: { messageId: { in: burst.map((m) => m.id) }, status: 'FAILED' },
        select: { error: true },
      });
      if (failed.some((f) => f.error && RATE_LIMIT_RE.test(f.error))) {
        await this.d.events.warn('ai', `media analysis rate-limited; message ${last.id} will be retried`);
        throw new PipelineRetryLater(AI_RETRY_DELAY_MS);
      }
    }
    const ctx: BurstContext = { ...ctxBase, media };
    // Per message: a location/sticker placeholder followed by a real question still has own text.
    const hasOwnText = burst.some((m) => this.messageHasOwnText(m));
    if (!hasOwnText && (media.tooLarge || media.unsupported || media.disabled || media.failed) && !hasUsefulMedia(media)) {
      await this.handleMediaProblem(ctx);
      return;
    }
    if (!hasOwnText && !media.summaryText.trim()) {
      await this.setStatuses(burst, 'SKIPPED', 'nothing to answer');
      return;
    }

    // 7. Classification (personal / sensitive / business / spam …) of exactly what the reply will see.
    const history = await this.d.repo.recentHistory(chat.id, 6, burst[0]!.id);
    const classification = await this.d.classifier.classify(
      {
        text: texts,
        mediaContext: media.summaryText,
        parts: this.messageTexts(burst),
        history: history.map((h) => ({ from: h.direction === 'INCOMING' ? 'contact' : 'owner', text: h.text })),
        messageId: last.id,
      },
      settings,
    );
    if (classification.llmFailure === 'rate_limit' && Date.now() - ctxBase.startedAt < AI_RETRY_WINDOW_MS) {
      // Don't silently route a rate-limited classification by heuristics: retry like reply rate limits.
      await this.d.events.warn('ai', `classifier rate-limited; message ${last.id} will be retried in ${AI_RETRY_DELAY_MS / 1000}s`);
      throw new PipelineRetryLater(AI_RETRY_DELAY_MS);
    }
    ctx.injectionSuspected = classification.injectionSuspected;
    await this.d.db.message.updateMany({
      where: { id: { in: burst.map((m) => m.id) } },
      data: {
        classification: classification.category,
        classificationConfidence: classification.confidence,
        // Derived from message content → encrypted at rest like the content itself.
        classificationReason: this.d.cipher.encrypt(classification.reason.slice(0, 300)),
        injectionSuspected: classification.injectionSuspected,
      },
    });

    if (classification.route === 'IGNORE') {
      await this.setStatuses(burst, 'IGNORED', `classified ${classification.category}`);
      return;
    }
    if (classification.route === 'OWNER') {
      await this.ownerPath(ctx, classification.category, classification.reason, 'personal');
      return;
    }

    // 8. AI reply.
    const result = await this.autoReply(ctx);
    if (result === 'lease-lost') throw new PipelineRetryLater(CHAT_BUSY_RETRY_MS);
  }

  // ───────────────────────────── paths ─────────────────────────────

  private async autoReply(ctx: BurstContext, ownerApproved = false): Promise<ReplyResult> {
    const { chat, settings, last } = ctx;
    // The owner answered meanwhile → stop before paying for generation.
    if (!ownerApproved && (await this.ownerReplied(ctx.burst))) {
      await this.setStatuses(ctx.burst, 'MANUAL', OWNER_REPLIED);
      return 'owner-replied';
    }
    const stopTyping = settings.typingIndicator ? this.startTyping(chat) : () => {};
    try {
      const [prompt, summary, history] = await Promise.all([
        this.d.prompts.getActive(),
        settings.summaryEnabled ? this.d.summaries.get(chat.id) : Promise.resolve(null),
        this.d.repo.recentHistory(chat.id, settings.historyWindow, ctx.burst[0]!.id),
      ]);
      const built = buildReplyContext({
        settings,
        ownerPrompt: prompt.content,
        summary,
        history,
        currentText: ctx.text,
        mediaSummary: ctx.media.summaryText,
        images: settings.attachImageToReply ? ctx.media.images.slice(0, 3) : [],
        injectionSuspected: ctx.injectionSuspected,
        timezone: this.d.timezone,
        ownerApproved,
      });

      let routed;
      try {
        // Tool actions run with the deployment's own credentials (GITHUB_TOKEN): only the super-admin's
        // workspace may be offered them, never another tenant.
        const tools = this.ownerId() === this.d.adminTelegramUserId && process.env.GITHUB_TOKEN ? (await import('../plugins/github.js')).GITHUB_TOOLS : undefined;
        routed = await this.d.ai.generateReply(
          { system: built.system, messages: built.messages, maxOutputTokens: built.maxOutputTokens, temperature: 0.7, ...(tools ? { tools } : {}) },
          { messageId: last.id },
        );
      } catch (error) {
        stopTyping();
        if (!ownerApproved && isRateLimitFailure(error) && Date.now() - ctx.startedAt < AI_RETRY_WINDOW_MS) {
          await this.d.events.warn('ai', `AI rate-limited; message ${last.id} will be retried in ${AI_RETRY_DELAY_MS / 1000}s`);
          throw new PipelineRetryLater(AI_RETRY_DELAY_MS);
        }
        const detail = error instanceof AllProvidersFailedError ? error.attempts.map((a) => `${a.model}: ${a.error}`).join('; ') : describeError(error);
        await this.d.events.error('ai', `reply generation failed: ${detail}`);
        if (ownerApproved) return 'failed';
        await this.ownerPath(ctx, 'AI_FAILED', detail.slice(0, 200), 'fallback');
        return 'owner';
      }

      if (routed.result.toolCalls && routed.result.toolCalls.length > 0) {
        stopTyping();
        const call = routed.result.toolCalls[0]!;
        const detail = JSON.stringify({ name: call.name, args: call.args });
        
        // Wait, if it's ownerApproved, it means the owner clicked "Let AI reply" earlier.
        // We still need to approve the tool.
        await this.ownerPath(ctx, 'TOOL_APPROVAL_1', detail, 'personal');
        return 'owner';
      }

      const policy = applyResponsePolicy(routed.result.text, { adminTelegramUserId: this.ownerId() });
      if (!policy.ok) {
        stopTyping();
        await this.d.events.warn('policy', `reply blocked (${policy.violation}) for message ${last.id}`);
        if (ownerApproved) return 'failed';
        await this.ownerPath(ctx, 'POLICY_BLOCKED', policy.violation, 'fallback');
        return 'owner';
      }

      const wait = remainingDelayMs(targetDelayMs(settings, policy.text.length), ctx.startedAt);
      if (wait > 0) await sleep(wait);

      const voice = await this.maybeVoice(ctx, policy.text);
      stopTyping();

      // Final gate right before sending: still our lease, nobody else answered, nothing newer joined.
      const gate = await this.preSendGate(ctx, ownerApproved);
      if (gate !== 'ok') return gate;

      const outcome = await this.d.replies.sendOnce({
        sourceMessageId: last.id,
        chat,
        kind: ownerApproved ? 'OWNER_APPROVED_AI' : 'AUTO_REPLY',
        text: policy.text,
        voice,
        // An owner-requested retry may re-use a claim that definitely failed (never an uncertain one).
        reclaimFailed: ownerApproved,
        meta: {
          provider: routed.provider,
          model: routed.model,
          reasoningEffort: routed.reasoningEffort,
          inputTokens: routed.result.usage.inputTokens,
          outputTokens: routed.result.usage.outputTokens,
          costUsd: routed.costUsd,
          latencyMs: routed.result.latencyMs,
          usedFallback: routed.usedFallback,
        },
      });
      const delivery = deliveryOf(outcome);
      if (delivery !== 'sent') {
        await this.handleSendFailure(ctx, delivery === 'uncertain', outcome.status === 'failed' ? outcome.error : 'already claimed', ownerApproved);
        return delivery;
      }
      await this.setStatuses(ctx.burst, 'ANSWERED', ownerApproved ? 'owner approved AI' : `ai:${routed.model}`);
      await this.maybeScheduleSummary(chat.id, settings);
      return 'sent';
    } finally {
      stopTyping();
    }
  }

  /** Last checks before a reply is sent. Anything but 'ok' means: do not send. */
  private async preSendGate(ctx: BurstContext, ownerApproved: boolean): Promise<'ok' | Exclude<ReplyResult, 'sent' | 'owner' | 'failed' | 'uncertain'>> {
    if (!(await ctx.lease.stillHeld())) {
      // Another worker may have taken the chat over: never send twice. The job is retried and
      // finds the messages answered (or re-claims them when nobody holds the chat any more).
      log.warn({ chatId: ctx.chat.id, messageId: ctx.last.id }, 'chat lease lost before sending; reply dropped');
      return 'lease-lost';
    }
    if (ownerApproved) {
      const item = ctx.attentionId === undefined ? null : await this.d.db.ownerAttention.findUnique({ where: { id: ctx.attentionId }, select: { status: true } });
      return item?.status === 'PENDING' ? 'ok' : 'resolved';
    }
    if (await this.ownerReplied(ctx.burst)) {
      await this.setStatuses(ctx.burst, 'MANUAL', OWNER_REPLIED);
      return 'owner-replied';
    }
    if (await this.d.repo.newerIncomingExists(ctx.chat.id, ctx.last.id)) {
      // A newer message joined the burst: its own job answers everything together.
      await this.d.db.message.updateMany({
        where: { id: { in: ctx.burst.map((m) => m.id) }, status: 'PROCESSING' },
        data: { status: 'QUEUED' },
      });
      log.info({ chatId: ctx.chat.id, messageId: ctx.last.id }, 'newer message arrived; the newer job answers the whole burst');
      return 'superseded';
    }
    return 'ok';
  }

  /**
   * A reply could not be delivered (or its outcome is unknown): the contact may be left without an
   * answer, so the owner gets an attention item. Owner-approved replies keep their existing item.
   */
  private async handleSendFailure(ctx: BurstContext, uncertain: boolean, error: string, ownerApproved: boolean): Promise<void> {
    if (ownerApproved) return;
    await this.setStatuses(ctx.burst, 'FAILED', uncertain ? 'telegram send outcome uncertain' : 'telegram send failed');
    await this.d.attention.create({
      messageId: ctx.last.id,
      chatId: ctx.chat.id,
      reason: 'SEND_FAILED',
      detail: uncertain
        ? 'outcome uncertain: the reply may have been delivered — check the chat before answering'
        : `Telegram rejected the reply: ${error.slice(0, 150)}`,
      displayText: this.displayText(ctx),
      userLabel: labelOf(ctx.sender, ctx.chat),
      waitingMessageSent: false,
      notify: ctx.settings.notifyOwnerAttention,
      burstMessageIds: ctx.burst.map((m) => m.id),
    });
  }

  /**
   * Hands the conversation to the owner: optional waiting notice (rate-limited per chat),
   * owner-attention item and admin-bot notification.
   */
  private async ownerPath(ctx: BurstContext, reason: string, detail: string | undefined, notice: 'personal' | 'fallback' | 'none'): Promise<void> {
    const { chat, settings, last } = ctx;
    if (await this.ownerReplied(ctx.burst)) {
      await this.setStatuses(ctx.burst, 'MANUAL', OWNER_REPLIED);
      return;
    }
    let waitingMessageSent = false;
    if (notice !== 'none' && !(await this.d.attention.recentNoticeInChat(chat.id, settings.personalNoticeCooldownMinutes))) {
      if (!(await ctx.lease.stillHeld())) throw new PipelineRetryLater(CHAT_BUSY_RETRY_MS);
      const text =
        notice === 'fallback'
          ? settings.fallbackReplyText
          : reason === 'PERSONAL' || reason === 'SENSITIVE'
            ? settings.personalReplyText
            : settings.ownerRequiredReplyText;
      const outcome = await this.d.replies.sendOnce({
        sourceMessageId: last.id,
        chat,
        kind: notice === 'personal' ? 'PERSONAL_NOTICE' : 'FALLBACK',
        text,
      });
      waitingMessageSent = deliveryOf(outcome) === 'sent';
    }
    await this.d.attention.create({
      messageId: last.id,
      chatId: chat.id,
      reason,
      detail,
      displayText: this.displayText(ctx),
      userLabel: labelOf(ctx.sender, chat),
      waitingMessageSent,
      notify: settings.notifyOwnerAttention,
      burstMessageIds: ctx.burst.map((m) => m.id),
    });
    await this.setStatuses(ctx.burst, 'OWNER_ATTENTION', reason);
  }

  /**
   * Owner awareness without a waiting message for bursts that get no reply for "quiet" reasons
   * (rate limited, media analysis disabled): at most one item per chat per 30 minutes.
   */
  private async lowPriorityAttention(ctx: BurstContext, reason: 'RATE_LIMITED' | 'MEDIA_DISABLED', detail?: string): Promise<void> {
    if (await this.d.attention.recentLowPriorityInChat(ctx.chat.id, LOW_PRIORITY_WINDOW_MINUTES)) return;
    await this.d.attention.create({
      messageId: ctx.last.id,
      chatId: ctx.chat.id,
      reason,
      ...(detail ? { detail } : {}),
      displayText: this.displayText(ctx),
      userLabel: labelOf(ctx.sender, ctx.chat),
      waitingMessageSent: false,
      notify: ctx.settings.notifyOwnerAttention,
      burstMessageIds: ctx.burst.map((m) => m.id),
    });
  }

  private async handleMediaProblem(ctx: BurstContext): Promise<void> {
    const { media, settings, chat, last } = ctx;
    const notice = async (text: string, reason: string): Promise<void> => {
      if (!(await ctx.lease.stillHeld())) throw new PipelineRetryLater(CHAT_BUSY_RETRY_MS);
      const outcome = await this.d.replies.sendOnce({ sourceMessageId: last.id, chat, kind: 'MEDIA_NOTICE', text });
      const delivery = deliveryOf(outcome);
      if (delivery === 'sent') return this.setStatuses(ctx.burst, 'ANSWERED', reason);
      return this.handleSendFailure(ctx, delivery === 'uncertain', outcome.status === 'failed' ? outcome.error : 'already claimed', false);
    };
    if (media.tooLarge) {
      if (settings.oversizedMediaAction === 'IGNORE') return this.setStatuses(ctx.burst, 'SKIPPED', 'media too large');
      if (settings.oversizedMediaAction === 'OWNER') return this.ownerPath(ctx, 'MEDIA_TOO_LARGE', undefined, 'none');
      return notice(settings.mediaTooLargeText, 'media too large notice');
    }
    if (media.unsupported) return notice(settings.unsupportedMediaText, 'unsupported media notice');
    if (media.disabled) {
      await this.setStatuses(ctx.burst, 'MANUAL', 'media analysis disabled');
      return this.lowPriorityAttention(ctx, 'MEDIA_DISABLED');
    }
    return this.ownerPath(ctx, 'MEDIA_FAILED', undefined, 'fallback');
  }

  // ───────────────────────────── owner actions (admin bot) ─────────────────────────────

  /**
   * "🤖 Let AI reply" from an owner-attention notification. Answers exactly the item's burst
   * (history comes from before its first message), under the chat lease. A reply that may already
   * have reached the contact is never re-sent; a reply that definitely failed can be retried.
   */
  async ownerApprovedAiReply(attentionId: number, adminTelegramUserId: bigint): Promise<OwnerAiOutcome> {
    const item = await this.d.attention.get(attentionId);
    if (!item || item.status !== 'PENDING') return 'resolved';
    const lease = await this.acquireLease(item.chatId);
    if (!lease) throw new PipelineRetryLater(CHAT_BUSY_RETRY_MS);
    try {
      const current = await this.d.attention.get(attentionId);
      if (!current || current.status !== 'PENDING') return 'resolved';
      if (current.uncertainDelivery) return 'uncertain';
      const claim = await this.d.db.aiResponse.findUnique({
        where: { sourceMessageId_kind: { sourceMessageId: current.messageId, kind: 'OWNER_APPROVED_AI' } },
        select: { status: true },
      });
      if (claim?.status === 'SENT') {
        // Delivered earlier (the worker stopped before resolving the item).
        await this.d.attention.resolve(attentionId, 'AI_REPLIED', adminTelegramUserId);
        return 'sent';
      }
      if (claim?.status === 'PENDING' || claim?.status === 'UNCERTAIN') return 'uncertain';

      const msgs = await this.d.db.message.findMany({
        where: { id: { in: current.burstMessageIds }, direction: 'INCOMING', deletedAt: null },
        orderBy: { id: 'asc' },
      });
      if (msgs.length === 0) return 'failed';
      const last = msgs.find((m) => m.id === current.messageId) ?? msgs[msgs.length - 1]!;
      const chat = (await this.d.db.chat.findUniqueOrThrow({
        where: { id: current.chatId },
        include: { connection: true, user: true },
      })) as LoadedChat;
      if (chat.connection.ownerUserId !== this.ownerId() || !chat.connection.isEnabled || !chat.connection.canReply) return 'failed';
      const settings = await this.d.settings.get();
      const result = await this.autoReply(
        {
          chat,
          burst: msgs,
          last,
          sender: chat.user,
          settings,
          text: this.burstTexts(msgs),
          media: await this.mediaFromStored(msgs),
          startedAt: Date.now(),
          injectionSuspected: msgs.some((m) => m.injectionSuspected),
          lease,
          attentionId,
        },
        true,
      );
      if (result === 'sent') {
        await this.d.attention.resolve(attentionId, 'AI_REPLIED', adminTelegramUserId);
        return 'sent';
      }
      if (result === 'lease-lost') throw new PipelineRetryLater(CHAT_BUSY_RETRY_MS);
      if (result === 'resolved' || result === 'uncertain') return result;
      return 'failed';
    } finally {
      await lease.release();
    }
  }

  /**
   * Owner typed a reply in the admin bot for an attention item. When an earlier reply for these
   * messages may already have been delivered, nothing is sent without `confirmed`.
   */
  async ownerManualReply(
    attentionId: number,
    text: string,
    adminTelegramUserId: bigint,
    opts: { confirmed?: boolean } = {},
  ): Promise<ManualReplyOutcome> {
    const item = await this.d.attention.get(attentionId);
    if (!item) return 'resolved';
    if (item.uncertainDelivery && !opts.confirmed) return 'confirm';
    const chat = await this.d.db.chat.findUniqueOrThrow({ where: { id: item.chatId } });
    const outcome = await this.d.replies.sendManual({ sourceMessageId: item.messageId, chat, text: text.slice(0, 4000) });
    if (outcome.status === 'failed') return outcome.uncertain ? 'uncertain' : 'failed';
    if (outcome.status !== 'sent') return 'failed';
    if (item.status === 'PENDING') await this.d.attention.resolve(attentionId, 'REPLIED', adminTelegramUserId);
    return 'sent';
  }

  /**
   * A `message.process` job went DEAD: the burst would otherwise stay QUEUED forever.
   * Marks it FAILED and gives the owner an attention item (no waiting message).
   */
  async handleDeadMessageJob(messageId: number, error: string): Promise<void> {
    const message = await this.d.db.message.findUnique({ where: { id: messageId } });
    if (!message || message.direction !== 'INCOMING' || TERMINAL.has(message.status)) return;
    const lease = await this.acquireLease(message.chatId);
    // Another job is working on this chat: it (or the sweeper) handles the message.
    if (!lease) return;
    try {
      await this.d.repo.recoverOrphanedProcessing(message.chatId);
      const anchor = message.deletedAt ? await this.d.repo.latestPendingBefore(message.chatId, message.id) : message;
      if (!anchor) return;
      const burst = await this.d.repo.pendingBurst(message.chatId, anchor.id, BURST_LIMIT);
      if (burst.length === 0) return;
      const last = burst[burst.length - 1]!;
      const chat = await this.d.db.chat.findUniqueOrThrow({ where: { id: message.chatId }, include: { user: true } });
      const settings = await this.d.settings.get();
      await this.setStatuses(burst, 'FAILED', 'processing failed');
      await this.d.attention.create({
        messageId: last.id,
        chatId: chat.id,
        reason: 'PROCESSING_FAILED',
        detail: error.slice(0, 200),
        displayText: this.burstTexts(burst) || `[${last.type.toLowerCase()}]`,
        userLabel: labelOf(chat.user, chat),
        waitingMessageSent: false,
        notify: settings.notifyOwnerAttention,
        burstMessageIds: burst.map((m) => m.id),
      });
      await this.d.events.error('pipeline', `message ${last.id} could not be processed; handed to the owner`);
    } finally {
      await lease.release();
    }
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async ownerReplied(burst: Message[]): Promise<boolean> {
    const first = burst[0]!;
    return this.d.repo.ownerRepliedSince(first.chatId, first.id, first.createdAt);
  }

  private messageTexts(burst: Message[]): string[] {
    return burst
      .map((m) => [this.d.cipher.decrypt(m.currentText), this.d.cipher.decrypt(m.currentCaption)].filter(Boolean).join('\n'))
      .filter((t) => t.trim());
  }

  private burstTexts(burst: Message[]): string {
    return this.messageTexts(burst).join('\n').slice(0, 6000);
  }

  private messageHasOwnText(m: Message): boolean {
    if (this.d.cipher.decrypt(m.currentCaption)?.trim()) return true;
    const text = this.d.cipher.decrypt(m.currentText)?.trim();
    if (!text) return false;
    return !(SYNTHETIC_TYPES.has(m.type) && PLACEHOLDER_RE.test(text));
  }

  private displayText(ctx: BurstContext): string {
    const display = [ctx.text, ctx.media.summaryText ? `\n${ctx.media.summaryText.slice(0, 400)}` : ''].join('').trim();
    return display || `[${ctx.last.type.toLowerCase()}]`;
  }

  /** Processes every message's media; stops before paid analysis once the daily AI budget is used up. */
  private async processBurstMedia(burst: Message[], settings: Settings): Promise<{ media: MessageMediaContext } | { costLimitSpent: number }> {
    const rows = await this.d.db.media.findMany({
      where: { messageId: { in: burst.map((m) => m.id) } },
      select: { messageId: true, status: true, kind: true },
      orderBy: { messageId: 'asc' },
    });
    if (rows.length === 0) return { media: emptyMedia() };
    const messageIds = [...new Set(rows.map((r) => r.messageId))];
    const contexts: MessageMediaContext[] = [];
    for (const messageId of messageIds) {
      const needsPaidAnalysis = rows.some((r) => r.messageId === messageId && r.status === 'PENDING' && r.kind !== 'STICKER');
      if (needsPaidAnalysis && settings.maxDailyAiCostUsd > 0) {
        const spent = await this.d.usage.costToday();
        if (spent >= settings.maxDailyAiCostUsd) return { costLimitSpent: spent };
      }
      try {
        contexts.push(await this.d.media.processMessageMedia(messageId));
      } catch (error) {
        log.error({ err: error, messageId }, 'media processing crashed');
        contexts.push({ ...emptyMedia(), failed: true, statuses: ['FAILED'] });
      }
    }
    return { media: mergeMedia(contexts) };
  }

  /** Media context from already-processed rows (owner-approved replies). */
  private async mediaFromStored(burst: Message[]): Promise<MessageMediaContext> {
    const rows = await this.d.db.media.findMany({ where: { messageId: { in: burst.map((m) => m.id) } } });
    if (rows.length === 0) return emptyMedia();
    const lines = rows.map((r) => {
      const t = this.d.cipher.decrypt(r.extractedText);
      const desc = this.d.cipher.decrypt(r.description);
      return `[${r.kind.toLowerCase()}] ${[t ? `Text: ${t.slice(0, 2000)}` : '', desc ? `Description: ${desc.slice(0, 1500)}` : ''].filter(Boolean).join(' ')}`;
    });
    return { ...emptyMedia(), summaryText: lines.join('\n'), statuses: rows.map((r) => r.status) };
  }

  private async maybeVoice(ctx: BurstContext, text: string): Promise<Buffer | null> {
    const mode = ctx.settings.voiceResponseMode;
    const wantsVoice = mode === 'voice' || (mode === 'adaptive' && ctx.burst.some((m) => m.type === 'VOICE' || m.type === 'VIDEO_NOTE'));
    if (!wantsVoice || !this.d.voice) return null;
    try {
      await this.d.sender.typing(ctx.chat.connectionId, ctx.chat.telegramChatId, 'record_voice');
      return await this.d.voice.toVoice(text, ctx.last.id);
    } catch (error) {
      log.warn({ error: describeError(error) }, 'voice synthesis failed; sending text');
      return null;
    }
  }

  private startTyping(chat: Chat): () => void {
    const tick = () => void this.d.sender.typing(chat.connectionId, chat.telegramChatId);
    tick();
    const timer = setInterval(tick, 4_500);
    timer.unref();
    return () => clearInterval(timer);
  }

  private async maybeScheduleSummary(chatId: number, settings: Settings): Promise<void> {
    try {
      if (await this.d.summaries.isDue(chatId, settings)) {
        const bucket = Math.floor(Date.now() / 600_000);
        await this.d.queue.enqueue('text', 'summary.update', { chatId }, { dedupeKey: `summary:${chatId}:${bucket}`, maxAttempts: 2 });
      }
    } catch (error) {
      log.warn({ error: describeError(error) }, 'could not schedule summary');
    }
  }

  /** Notifies the owner once per local day, even when several jobs hit the limit concurrently. */
  private async notifyCostLimitOnce(settings: Settings, spent: number): Promise<void> {
    const today = localDateKey(new Date(), this.d.timezone);
    if (settings.costLimitNotifiedOn === today) return;
    // Conditional upsert: exactly one caller flips the stored day and wins the notification.
    // Raw SQL is not tenant-scoped by the Prisma extension: the tenant goes in explicitly.
    const tenantId = currentTenantId('cost limit');
    const won = await this.d.db.$queryRaw<Array<{ key: string }>>`
      INSERT INTO settings ("tenantId", key, value, "updatedAt")
      VALUES (${tenantId}, 'costLimitNotifiedOn', ${JSON.stringify(today)}::jsonb, now())
      ON CONFLICT ("tenantId", key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()
       WHERE settings.value IS DISTINCT FROM EXCLUDED.value
      RETURNING key`;
    this.d.settings.invalidate();
    if (won.length === 0) return;
    await this.d.notifier.text(
      `💸 Kunlik AI limiti tugadi: ≈ $${spent.toFixed(2)} / $${settings.maxDailyAiCostUsd.toFixed(2)}. Bugun AI javoblar to‘xtatildi; yangi xabarlar sizga yuboriladi.`,
    );
  }

  private async setStatuses(burst: Message[], status: MessageStatus, reason?: string): Promise<void> {
    await this.d.db.message.updateMany({
      where: { id: { in: burst.map((m) => m.id) } },
      data: {
        status,
        statusReason: reason?.slice(0, 200) ?? null,
        ...(status === 'PROCESSING' || status === 'QUEUED' ? {} : { processedAt: new Date() }),
      },
    });
  }
}

/** Only a SENT claim counts as delivered; an existing FAILED/PENDING/UNCERTAIN claim is not a success. */
function deliveryOf(outcome: SendOutcome): 'sent' | 'failed' | 'uncertain' {
  if (outcome.status === 'sent') return 'sent';
  if (outcome.status === 'failed') return outcome.uncertain ? 'uncertain' : 'failed';
  if (outcome.existing === 'SENT') return 'sent';
  return outcome.existing === 'FAILED' ? 'failed' : 'uncertain';
}

export function emptyMedia(): MessageMediaContext {
  return { summaryText: '', images: [], statuses: [], tooLarge: false, unsupported: false, disabled: false, failed: false };
}

function mergeMedia(list: MessageMediaContext[]): MessageMediaContext {
  const images: ImageInput[] = [];
  for (const c of list) images.push(...c.images);
  const transcripts = list.map((c) => c.transcript).filter(Boolean);
  return {
    summaryText: list.map((c) => c.summaryText).filter((s) => s.trim()).join('\n'),
    images,
    statuses: list.flatMap((c) => c.statuses),
    tooLarge: list.some((c) => c.tooLarge),
    unsupported: list.some((c) => c.unsupported),
    disabled: list.some((c) => c.disabled),
    failed: list.some((c) => c.failed),
    ...(transcripts.length > 0 ? { transcript: transcripts.join('\n') } : {}),
  };
}

function hasUsefulMedia(m: MessageMediaContext): boolean {
  return m.statuses.some((s) => s === 'DONE');
}

function labelOf(sender: TelegramUser | null, chat: Chat): string {
  return sender ? displayUser(sender) : `chat ${chat.telegramChatId}`;
}

function escapeLabel(sender: TelegramUser | null, chat: Chat): string {
  return labelOf(sender, chat).replace(/[<>&]/g, '');
}
