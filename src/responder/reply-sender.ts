import type { Db } from '../database/client.js';
import type { Chat, ResponseKind, ResponseStatus } from '../generated/prisma/client.js';
import { Prisma } from '../generated/prisma/client.js';
import type { EventLog } from '../logging/events.js';
import { childLogger } from '../logging/logger.js';
import { describeError } from '../logging/sanitize.js';
import { isUniqueViolation, type MessageRepository } from '../messages/message.repository.js';
import type { ContentCipher } from '../security/crypto.js';
import { SendError, type TelegramSender } from '../telegram/main/sender.js';

const log = childLogger('reply-sender');

export interface ReplyMeta {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  usedFallback?: boolean;
}

export type SendOutcome =
  | { status: 'sent'; telegramMessageId: number }
  /** A claim for (source message, kind) already exists; `existing` is its status (only SENT means delivered). */
  | { status: 'duplicate'; existing: ResponseStatus }
  /** `uncertain`: Telegram may have delivered it (network error after sending) — never resend automatically. */
  | { status: 'failed'; error: string; uncertain: boolean };

/**
 * Exactly-once-or-never delivery of replies.
 * A unique (sourceMessageId, kind) row is claimed BEFORE calling Telegram; if a retry finds the
 * claim it does not send again. An unknown outcome (network error after sending) is stored as
 * UNCERTAIN and never retried automatically — a missing reply is better than a duplicate.
 */
export class ReplySender {
  constructor(
    private readonly db: Db,
    private readonly repo: MessageRepository,
    private readonly sender: TelegramSender,
    private readonly cipher: ContentCipher,
    private readonly events: EventLog,
  ) {}

  async sendOnce(p: {
    sourceMessageId: number;
    chat: Chat;
    kind: ResponseKind;
    text: string;
    meta?: ReplyMeta;
    voice?: Buffer | null;
    /** Re-use an existing claim that DEFINITELY failed (owner-requested retry). UNCERTAIN claims are never re-used. */
    reclaimFailed?: boolean;
  }): Promise<SendOutcome> {
    const fields = {
      status: 'PENDING' as const,
      text: this.cipher.encrypt(p.text),
      provider: p.meta?.provider ?? null,
      model: p.meta?.model ?? null,
      reasoningEffort: p.meta?.reasoningEffort ?? null,
      inputTokens: p.meta?.inputTokens ?? 0,
      outputTokens: p.meta?.outputTokens ?? 0,
      costUsd: new Prisma.Decimal((p.meta?.costUsd ?? 0).toFixed(6)),
      latencyMs: p.meta?.latencyMs ?? null,
      usedFallback: p.meta?.usedFallback ?? false,
    };
    let claimId: number;
    try {
      const claim = await this.db.aiResponse.create({
        data: { sourceMessageId: p.sourceMessageId, chatId: p.chat.id, kind: p.kind, ...fields },
      });
      claimId = claim.id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const where = { sourceMessageId_kind: { sourceMessageId: p.sourceMessageId, kind: p.kind } };
      if (p.reclaimFailed) {
        // Atomic: only one retry can flip FAILED → PENDING.
        const reclaimed = await this.db.aiResponse.updateMany({
          where: { sourceMessageId: p.sourceMessageId, kind: p.kind, status: 'FAILED' },
          data: { ...fields, error: null, sentAt: null, sentTelegramMessageId: null },
        });
        if (reclaimed.count === 1) {
          const row = await this.db.aiResponse.findUniqueOrThrow({ where, select: { id: true } });
          return this.deliver(row.id, p.chat, p.text, p.voice ?? null);
        }
      }
      const existing = await this.db.aiResponse.findUnique({ where, select: { status: true } });
      log.info({ sourceMessageId: p.sourceMessageId, kind: p.kind, existing: existing?.status }, 'reply already claimed; not sending twice');
      return { status: 'duplicate', existing: existing?.status ?? 'PENDING' };
    }
    return this.deliver(claimId, p.chat, p.text, p.voice ?? null);
  }

  /** Owner-typed reply from the admin bot. Recorded once per source message; always delivered. */
  async sendManual(p: { sourceMessageId: number; chat: Chat; text: string }): Promise<SendOutcome> {
    try {
      const claim = await this.db.aiResponse.create({
        data: {
          sourceMessageId: p.sourceMessageId,
          chatId: p.chat.id,
          kind: 'OWNER_MANUAL',
          status: 'PENDING',
          text: this.cipher.encrypt(p.text),
        },
      });
      return this.deliver(claim.id, p.chat, p.text, null);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Additional manual replies to the same message: send without a second ai_responses row.
      return this.deliver(null, p.chat, p.text, null);
    }
  }

  private async deliver(claimId: number | null, chat: Chat, text: string, voice: Buffer | null): Promise<SendOutcome> {
    let telegramMessageId: number;
    try {
      telegramMessageId = voice
        ? await this.sender.sendVoice({ connectionId: chat.connectionId, chatId: chat.telegramChatId, ogg: voice })
        : await this.sender.sendText({ connectionId: chat.connectionId, chatId: chat.telegramChatId, text });
    } catch (error) {
      const definitelyNotSent = error instanceof SendError && error.definitelyNotSent;
      const desc = describeError(error);
      if (claimId !== null)
        await this.db.aiResponse
          .update({ where: { id: claimId }, data: { status: definitelyNotSent ? 'FAILED' : 'UNCERTAIN', error: desc } })
          .catch((e: unknown) => log.error({ claimId, error: describeError(e) }, 'could not record the failed send'));
      await this.events.error('telegram-send', `reply ${definitelyNotSent ? 'rejected' : 'outcome unknown'}: ${desc}`);
      return { status: 'failed', error: desc, uncertain: !definitelyNotSent };
    }

    // Delivered. Bookkeeping failures below must never turn a delivered reply into a "failure"
    // (that would make callers retry or alert the owner about a message the contact already has).
    if (claimId !== null) {
      try {
        await this.db.aiResponse.update({
          where: { id: claimId },
          data: { status: 'SENT', sentTelegramMessageId: telegramMessageId, sentAt: new Date() },
        });
      } catch (error) {
        log.error({ claimId, error: describeError(error) }, 'reply delivered but its claim could not be marked SENT');
        await this.events.error('telegram-send', `reply delivered; claim update failed: ${describeError(error)}`).catch(() => undefined);
      }
    }
    try {
      await this.repo.insertMessage(
        {
          connectionId: chat.connectionId,
          telegramMessageId,
          chatId: chat.telegramChatId,
          chatType: chat.type,
          sender: null,
          type: voice ? 'VOICE' : 'TEXT',
          text: voice ? `[voice reply] ${text}` : text,
          media: [],
          sentByBusinessBot: true,
          date: new Date(),
        },
        chat,
        null,
        'OUTGOING_BOT',
        'ANSWERED',
      );
    } catch (error) {
      log.error({ chatId: chat.id, error: describeError(error) }, 'reply delivered but could not be stored in history');
      await this.events.error('telegram-send', `reply delivered; history insert failed: ${describeError(error)}`).catch(() => undefined);
    }
    return { status: 'sent', telegramMessageId };
  }
}
