import type { AuditService } from '../audit/audit.service.js';
import type { Db } from '../database/client.js';
import type { AttentionStatus, MessageStatus } from '../generated/prisma/client.js';
import { isUniqueViolation } from '../messages/message.repository.js';
import type { ContentCipher } from '../security/crypto.js';
import { displayUser } from '../telegram/common/html.js';
import type { AdminNotifier } from '../telegram/admin/notifier.js';

export interface AttentionView {
  id: number;
  status: AttentionStatus;
  reason: string;
  detail: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  messageId: number;
  /** Every incoming message this item covers (oldest first); owner actions use exactly these. */
  burstMessageIds: number[];
  chatId: number;
  telegramChatId: bigint;
  connectionId: string;
  telegramMessageId: number;
  text: string;
  userLabel: string;
  senderTelegramUserId: bigint | null;
  adminNotificationMessageId: number | null;
  /** A reply for these messages has an unknown delivery outcome (it may have reached the contact). */
  uncertainDelivery: boolean;
}

const STATUS_LINES: Record<AttentionStatus, string> = {
  PENDING: '⏳ Kutilmoqda',
  REPLIED: '✅ Siz javob berdingiz',
  AI_REPLIED: '🤖 AI javob berdi',
  IGNORED: '🚫 E’tiborsiz qoldirildi',
  RESOLVED_BY_OWNER: '✅ Siz Telegram’da o‘zingiz javob berdingiz',
};

/** Human labels for reasons created by the pipeline that the generic notifier table doesn't know. */
export const EXTRA_REASON_LABELS: Record<string, string> = {
  SEND_FAILED: 'Javobni Telegram’ga yuborib bo‘lmadi',
  PROCESSING_FAILED: 'Xabarni qayta ishlab bo‘lmadi',
  RATE_LIMITED: 'Limitdan oshdi (javob berilmadi)',
  MEDIA_DISABLED: 'Media tahlili o‘chirilgan',
};

/** Low-priority reasons: at most one item per chat per LOW_PRIORITY_WINDOW_MINUTES. */
export const LOW_PRIORITY_REASONS = ['RATE_LIMITED', 'MEDIA_DISABLED'] as const;

/** What a resolved item's still-open messages become, so they never count as pending again. */
const FINAL_MESSAGE_STATUS: Record<Exclude<AttentionStatus, 'PENDING'>, { status: MessageStatus; reason: string }> = {
  REPLIED: { status: 'MANUAL', reason: 'owner replied via admin bot' },
  AI_REPLIED: { status: 'ANSWERED', reason: 'owner approved AI' },
  IGNORED: { status: 'MANUAL', reason: 'owner ignored' },
  RESOLVED_BY_OWNER: { status: 'MANUAL', reason: 'owner replied personally' },
};

export class OwnerAttentionService {
  constructor(
    private readonly db: Db,
    private readonly cipher: ContentCipher,
    private readonly notifier: AdminNotifier,
    private readonly audit: AuditService,
  ) {}

  /**
   * Adds a message (burst) to the owner queue and notifies the admin bot (once per message).
   * Returns null when the message is already queued (duplicate processing).
   */
  async create(p: {
    messageId: number;
    chatId: number;
    reason: string;
    detail?: string;
    displayText: string;
    userLabel: string;
    waitingMessageSent: boolean;
    notify: boolean;
    /** All incoming messages covered by the item (defaults to just `messageId`). */
    burstMessageIds?: number[];
  }): Promise<number | null> {
    let id: number;
    const burst = [...new Set([...(p.burstMessageIds ?? []), p.messageId])].sort((a, b) => a - b);
    try {
      const row = await this.db.ownerAttention.create({
        data: {
          messageId: p.messageId,
          chatId: p.chatId,
          reason: p.reason,
          burstMessageIds: burst,
          // Derived from message content (classifier reason, errors) → encrypted at rest.
          detail: this.cipher.encrypt(p.detail?.slice(0, 300) ?? null),
        },
      });
      id = row.id;
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
    if (p.notify) {
      const notificationId = await this.notifier.ownerAttention({
        attentionId: id,
        userLabel: p.userLabel,
        text: p.displayText,
        reason: EXTRA_REASON_LABELS[p.reason] ?? p.reason,
        detail: p.detail,
        waitingMessageSent: p.waitingMessageSent,
      });
      if (notificationId)
        await this.db.ownerAttention.update({ where: { id }, data: { adminNotificationMessageId: notificationId } });
    }
    return id;
  }

  async get(id: number): Promise<AttentionView | null> {
    const row = await this.db.ownerAttention.findUnique({
      where: { id },
      include: { message: { include: { sender: true } }, chat: true },
    });
    if (!row) return null;
    const burstMessageIds = row.burstMessageIds.length > 0 ? row.burstMessageIds : [row.messageId];
    const uncertain = await this.db.aiResponse.count({
      where: {
        sourceMessageId: { in: [...new Set([...burstMessageIds, row.messageId])] },
        kind: { in: ['AUTO_REPLY', 'OWNER_APPROVED_AI', 'OWNER_MANUAL'] },
        status: 'UNCERTAIN',
      },
    });
    return {
      id: row.id,
      status: row.status,
      reason: row.reason,
      detail: this.cipher.decrypt(row.detail),
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
      messageId: row.messageId,
      burstMessageIds,
      chatId: row.chatId,
      telegramChatId: row.chat.telegramChatId,
      connectionId: row.chat.connectionId,
      telegramMessageId: row.message.telegramMessageId,
      text: this.cipher.decrypt(row.message.currentText) ?? this.cipher.decrypt(row.message.currentCaption) ?? `[${row.message.type.toLowerCase()}]`,
      userLabel: row.message.sender ? displayUser(row.message.sender) : `chat ${row.chat.telegramChatId}`,
      senderTelegramUserId: row.message.sender?.telegramUserId ?? null,
      adminNotificationMessageId: row.adminNotificationMessageId,
      uncertainDelivery: uncertain > 0,
    };
  }

  async listPending(take: number, skip: number): Promise<{ items: AttentionView[]; total: number }> {
    const where = { status: 'PENDING' as const };
    const [rows, total] = await Promise.all([
      this.db.ownerAttention.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip, select: { id: true } }),
      this.db.ownerAttention.count({ where }),
    ]);
    const items = (await Promise.all(rows.map((r) => this.get(r.id)))).filter((v): v is AttentionView => v !== null);
    return { items, total };
  }

  async countPending(): Promise<number> {
    return this.db.ownerAttention.count({ where: { status: 'PENDING' } });
  }

  /** Is there an unresolved item (or a recent notice) in this chat within `minutes`? */
  async recentNoticeInChat(chatId: number, minutes: number): Promise<boolean> {
    if (minutes <= 0) return false;
    const since = new Date(Date.now() - minutes * 60_000);
    const count = await this.db.aiResponse.count({
      where: { chatId, kind: { in: ['PERSONAL_NOTICE', 'FALLBACK'] }, status: 'SENT', createdAt: { gte: since } },
    });
    return count > 0;
  }

  /** Was a low-priority item (rate limit / media disabled) created for this chat within `minutes`? */
  async recentLowPriorityInChat(chatId: number, minutes: number): Promise<boolean> {
    const count = await this.db.ownerAttention.count({
      where: { chatId, reason: { in: [...LOW_PRIORITY_REASONS] }, createdAt: { gte: new Date(Date.now() - minutes * 60_000) } },
    });
    return count > 0;
  }

  /**
   * Resolves a PENDING item. Returns false when it was already resolved (double click / race).
   * Its still-open messages move to a final status so they never count as pending again.
   */
  async resolve(id: number, status: Exclude<AttentionStatus, 'PENDING'>, adminTelegramUserId?: bigint): Promise<boolean> {
    const result = await this.db.ownerAttention.updateMany({
      where: { id, status: 'PENDING' },
      data: { status, resolvedAt: new Date() },
    });
    if (result.count === 0) return false;
    const row = await this.db.ownerAttention.findUnique({ where: { id } });
    if (row) {
      const final = FINAL_MESSAGE_STATUS[status];
      await this.db.message.updateMany({
        where: {
          id: { in: [...new Set([...row.burstMessageIds, row.messageId])] },
          direction: 'INCOMING',
          status: { in: ['OWNER_ATTENTION', 'QUEUED', 'RECEIVED'] },
        },
        data: { status: final.status, statusReason: final.reason, processedAt: new Date() },
      });
    }
    if (row?.adminNotificationMessageId) await this.notifier.markAttentionResolved(row.adminNotificationMessageId, STATUS_LINES[status]);
    if (adminTelegramUserId !== undefined)
      await this.audit.record(adminTelegramUserId, 'OWNER_ATTENTION_RESOLVED', `attention:${id}`, { status });
    return true;
  }

  /** The owner wrote in the chat themselves → close pending items for that chat. */
  async resolveByOwnerReply(chatId: number): Promise<number> {
    const pending = await this.db.ownerAttention.findMany({ where: { chatId, status: 'PENDING' }, select: { id: true } });
    let count = 0;
    for (const p of pending) if (await this.resolve(p.id, 'RESOLVED_BY_OWNER')) count++;
    return count;
  }
}
