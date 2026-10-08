import type { Api } from 'grammy';
import type { Message } from 'grammy/types';
import { vi } from 'vitest';
import type { AiRouter, RoutedResult } from '../../src/ai/router/types.js';
import type { GenerateTextResult } from '../../src/ai/types.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { MessageClassifier } from '../../src/classifiers/classifier.js';
import { PromptService } from '../../src/conversations/prompt.service.js';
import { SummaryService } from '../../src/conversations/summary.service.js';
import type { Db } from '../../src/database/client.js';
import { EventLog } from '../../src/logging/events.js';
import type { MediaProcessor, MessageMediaContext } from '../../src/media/types.js';
import { MessageRepository } from '../../src/messages/message.repository.js';
import { OwnerAttentionService } from '../../src/owner-attention/attention.service.js';
import { PgQueue } from '../../src/queues/pg-queue.js';
import { ReplyPipeline } from '../../src/responder/pipeline.js';
import { ReplySender } from '../../src/responder/reply-sender.js';
import { RulesService } from '../../src/rules/rules.service.js';
import { ContentCipher } from '../../src/security/crypto.js';
import { buildDefaultSettings } from '../../src/settings/schema.js';
import { SettingsService } from '../../src/settings/settings.service.js';
import { UsageService } from '../../src/statistics/usage.service.js';
import type { AdminNotifier } from '../../src/telegram/admin/notifier.js';
import { BusinessHandlers } from '../../src/telegram/main/business.handlers.js';
import { ConnectionService } from '../../src/telegram/main/connection.service.js';
import { SendError, type TelegramSender } from '../../src/telegram/main/sender.js';
import { TEST_ADMIN_ID, testEnv } from './env.js';

export const OWNER_ID = TEST_ADMIN_ID;
export const CONNECTION_ID = 'bc-test-1';

export function fakeNotifier() {
  const calls: Array<{ method: string; args: unknown }> = [];
  const rec = (method: string) =>
    vi.fn(async (args?: unknown) => {
      calls.push({ method, args });
      return 9000 + calls.length;
    });
  const notifier = {
    text: rec('text'),
    ownerAttention: rec('ownerAttention'),
    messageEdited: rec('messageEdited'),
    messageDeleted: rec('messageDeleted'),
    deletedUnknown: rec('deletedUnknown'),
    markAttentionResolved: rec('markAttentionResolved'),
  };
  return { notifier: notifier as unknown as AdminNotifier, calls, raw: notifier };
}

export function fakeSender() {
  let nextId = 5000;
  const sent: Array<{ chatId: bigint; text: string; connectionId: string; voice?: boolean }> = [];
  const behaviour = { fail: null as null | 'rejected' | 'unknown' };
  const sender = {
    sendText: vi.fn(async (p: { connectionId: string; chatId: bigint; text: string }) => {
      if (behaviour.fail === 'rejected') throw new SendError('Bad Request: chat not active', true);
      if (behaviour.fail === 'unknown') throw new SendError('socket hang up', false);
      sent.push({ chatId: p.chatId, text: p.text, connectionId: p.connectionId });
      return ++nextId;
    }),
    sendVoice: vi.fn(async (p: { connectionId: string; chatId: bigint }) => {
      sent.push({ chatId: p.chatId, text: '[voice]', connectionId: p.connectionId, voice: true });
      return ++nextId;
    }),
    typing: vi.fn(async () => undefined),
  };
  return { sender: sender as unknown as TelegramSender, sent, behaviour };
}

function routed(text: string, model = 'gemini-3.8-flash'): RoutedResult<GenerateTextResult> {
  return {
    result: { text, usage: { inputTokens: 100, outputTokens: 20 }, provider: 'gemini', model, latencyMs: 5 },
    provider: 'gemini',
    model,
    usedFallback: false,
    costUsd: 0.0001,
    reasoningEffort: 'low',
  };
}

export function fakeAi() {
  const state = {
    classification: { category: 'BUSINESS', confidence: 0.95, requires_owner: false, reason: 'service question' } as Record<string, unknown>,
    reply: 'Ha, albatta. Landing sahifa 3-5 kunda tayyor bo‘ladi.',
    failReply: false as boolean | 'ratelimit',
    failClassify: false as false | 'ratelimit' | 'error',
    /** When set, generateReply waits for it (simulates a slow AI call). */
    replyGate: null as Promise<void> | null,
  };
  const ai = {
    classify: vi.fn(async (_req: unknown, _ctx?: unknown) => {
      if (state.failClassify) {
        const { AllProvidersFailedError } = await import('../../src/ai/types.js');
        const error = state.failClassify === 'ratelimit' ? 'gemini HTTP 429: RESOURCE_EXHAUSTED quota' : 'SERVER: 503';
        throw new AllProvidersFailedError('CLASSIFY', [{ provider: 'gemini', model: 'm', error }]);
      }
      return routed(JSON.stringify(state.classification), 'classifier');
    }),
    generateReply: vi.fn(async (_req: unknown, _ctx?: unknown) => {
      if (state.replyGate) await state.replyGate;
      if (state.failReply) {
        const { AllProvidersFailedError } = await import('../../src/ai/types.js');
        const error = state.failReply === 'ratelimit' ? 'gemini HTTP 429: RESOURCE_EXHAUSTED quota' : 'SERVER: 503';
        throw new AllProvidersFailedError('TEXT', [{ provider: 'gemini', model: 'm', error }]);
      }
      return routed(state.reply);
    }),
    summarize: vi.fn(async () => routed('summary')),
    analyzeImage: vi.fn(async () => routed('an image')),
    transcribe: vi.fn(),
    analyzeVideo: vi.fn(async () => routed('a video')),
    synthesizeSpeech: vi.fn(),
    canTranscribe: vi.fn(async () => true),
    canSynthesizeSpeech: vi.fn(async () => false),
  };
  return { ai: ai as unknown as AiRouter, state, raw: ai };
}

export function fakeMedia(ctx: Partial<MessageMediaContext> = {}) {
  const media: MediaProcessor = {
    processMessageMedia: vi.fn(async (): Promise<MessageMediaContext> => ({
      summaryText: '',
      images: [],
      statuses: ['DONE'],
      tooLarge: false,
      unsupported: false,
      disabled: false,
      failed: false,
      ...ctx,
    })),
  };
  return media;
}

/** Real services on a real (test) database with fake Telegram/AI edges. */
export async function buildHarness(db: Db, opts: { settingsOverrides?: Record<string, unknown> } = {}) {
  const env = testEnv();
  const cipher = new ContentCipher(env.DATA_ENCRYPTION_KEY);
  const audit = new AuditService(db);
  const events = new EventLog(db);
  const settings = new SettingsService(db, { ...buildDefaultSettings(env), debounceSeconds: 0, responseDelayMode: 'OFF', typingIndicator: false }, audit);
  for (const [k, v] of Object.entries(opts.settingsOverrides ?? {})) await settings.set(k as never, v as never);
  const { notifier, calls: notifications, raw: notifierRaw } = fakeNotifier();
  const { sender, sent, behaviour: senderBehaviour } = fakeSender();
  const { ai, state: aiState, raw: aiRaw } = fakeAi();
  const repo = new MessageRepository(db, cipher);
  const rules = new RulesService(db, audit);
  const queue = new PgQueue(db);
  const usage = new UsageService(db, 'Asia/Tashkent');
  const prompts = new PromptService(db, audit, async () => 'Komron');
  const summaries = new SummaryService(db, repo, ai, cipher);
  const replies = new ReplySender(db, repo, sender, cipher, events);
  const attention = new OwnerAttentionService(db, cipher, notifier, audit);
  const api = { getBusinessConnection: vi.fn(async () => Promise.reject(new Error('not found'))) } as unknown as Api;
  const connections = new ConnectionService(db, api, notifier, events);
  let media: MediaProcessor = fakeMedia();
  const mediaProxy: MediaProcessor = { processMessageMedia: (id) => media.processMessageMedia(id) };
  const pipeline = new ReplyPipeline({
    db,
    repo,
    settings,
    rules,
    classifier: new MessageClassifier(ai),
    ai,
    media: mediaProxy,
    prompts,
    summaries,
    sender,
    replies,
    attention,
    notifier,
    usage,
    queue,
    events,
    cipher,
    timezone: 'Asia/Tashkent',
    adminTelegramUserId: OWNER_ID,
  });
  const business = new BusinessHandlers({ db, repo, connections, settings, rules, queue, attention, notifier, events, logMessageContent: false });

  await connections.upsertFromUpdate({
    id: CONNECTION_ID,
    user: { id: Number(OWNER_ID), is_bot: false, first_name: 'Komron' },
    user_chat_id: Number(OWNER_ID),
    date: Math.floor(Date.now() / 1000),
    is_enabled: true,
    can_reply: true,
    rights: { can_reply: true },
  } as never);
  notifications.length = 0;
  for (const fn of Object.values(notifierRaw)) fn.mockClear();

  return {
    env,
    db,
    cipher,
    audit,
    settings,
    repo,
    rules,
    queue,
    usage,
    prompts,
    attention,
    connections,
    pipeline,
    business,
    notifier: notifierRaw,
    notifications,
    sent,
    senderBehaviour,
    ai: aiRaw,
    aiState,
    replies,
    setMedia(m: MediaProcessor) {
      media = m;
    },
    /** Makes the AI reply call wait until `release()` (slow AI). */
    holdReplies() {
      let release!: () => void;
      aiState.replyGate = new Promise<void>((r) => (release = r));
      return {
        release: () => {
          aiState.replyGate = null;
          release();
        },
      };
    },
    /** Runs every due message job of the given queues once, like the worker would. */
    async drain(queues: Array<'text' | 'media'> = ['text', 'media']) {
      for (let round = 0; round < 5; round++) {
        let ran = 0;
        for (const q of queues) {
          const jobs = await queue.claim(q, 'test', 10);
          for (const job of jobs) {
            ran++;
            if (job.type === 'message.process') {
              const payload = job.payload as { messageId: number };
              await pipeline.processMessage(payload.messageId, job.queue as 'text' | 'media');
            }
            await queue.complete(job.id);
          }
        }
        if (ran === 0) break;
      }
    },
  };
}

/** Waits until `check` returns true (polling; for concurrency tests). */
export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

let nextMsgId = 100;
export function businessMessage(over: Partial<Message> & { fromId?: number; username?: string } = {}): Message {
  const fromId = over.fromId ?? 4242;
  const { fromId: _f, username, ...rest } = over;
  return {
    message_id: ++nextMsgId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: fromId, type: 'private', first_name: 'Ali' },
    from: { id: fromId, is_bot: false, first_name: 'Ali', username: username ?? 'ali_client' },
    business_connection_id: CONNECTION_ID,
    text: 'Salom',
    ...rest,
  } as Message;
}
