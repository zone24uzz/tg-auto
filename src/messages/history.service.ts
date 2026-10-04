import type { Db } from '../database/client.js';
import type { Classification, MessageStatus, MessageType, Prisma } from '../generated/prisma/client.js';
import type { ContentCipher } from '../security/crypto.js';
import { startOfDayInTz } from '../utils/time.js';
import type { MessageRepository, StoredVersion } from './message.repository.js';

export const HISTORY_FILTERS = ['all', 'today', 'ai', 'manual', 'personal', 'edited', 'deleted', 'media'] as const;
export type HistoryFilter = (typeof HISTORY_FILTERS)[number];

export interface HistoryListItem {
  id: number;
  createdAt: Date;
  type: MessageType;
  status: MessageStatus;
  classification: Classification | null;
  preview: string;
  userLabel: string;
  edited: boolean;
  deleted: boolean;
}

export interface MessageDetail {
  id: number;
  chatId: number;
  telegramChatId: bigint;
  telegramMessageId: number;
  direction: string;
  type: MessageType;
  status: MessageStatus;
  statusReason: string | null;
  classification: Classification | null;
  classificationConfidence: number | null;
  classificationReason: string | null;
  injectionSuspected: boolean;
  telegramDate: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  sender: { telegramUserId: bigint; username: string | null; firstName: string | null; lastName: string | null } | null;
  versions: StoredVersion[];
  media: Array<{ kind: string; status: string; fileName: string | null; extractedText: string | null; description: string | null; error: string | null }>;
  responses: Array<{
    kind: string;
    status: string;
    text: string | null;
    provider: string | null;
    model: string | null;
    reasoningEffort: string | null;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    latencyMs: number | null;
    usedFallback: boolean;
    createdAt: Date;
  }>;
  attention: { id: number; status: string; reason: string } | null;
}

/** Read-side queries for the admin "💬 Message History" screens. */
export class HistoryService {
  constructor(
    private readonly db: Db,
    private readonly repo: MessageRepository,
    private readonly cipher: ContentCipher,
    private readonly timezone: string,
  ) {}

  private where(filter: HistoryFilter, extra: Prisma.MessageWhereInput = {}): Prisma.MessageWhereInput {
    const base: Prisma.MessageWhereInput = { direction: 'INCOMING', ...extra };
    switch (filter) {
      case 'today':
        return { ...base, createdAt: { gte: startOfDayInTz(new Date(), this.timezone) } };
      case 'ai':
        return { ...base, responses: { some: { kind: { in: ['AUTO_REPLY', 'OWNER_APPROVED_AI'] }, status: 'SENT' } } };
      case 'manual':
        return { ...base, status: { in: ['MANUAL', 'OWNER_ATTENTION'] } };
      case 'personal':
        return { ...base, classification: { in: ['PERSONAL', 'SENSITIVE', 'REQUIRES_OWNER'] } };
      case 'edited':
        return { ...base, versionCount: { gt: 1 } };
      case 'deleted':
        return { ...base, deletedAt: { not: null } };
      case 'media':
        return { ...base, media: { some: {} } };
      case 'all':
      default:
        return base;
    }
  }

  async list(filter: HistoryFilter, take: number, skip: number, opts: { senderTelegramUserId?: bigint } = {}) {
    const extra: Prisma.MessageWhereInput = opts.senderTelegramUserId ? { sender: { telegramUserId: opts.senderTelegramUserId } } : {};
    const where = this.where(filter, extra);
    const orderBy: Prisma.MessageOrderByWithRelationInput =
      filter === 'deleted' ? { deletedAt: 'desc' } : filter === 'edited' ? { editedAt: 'desc' } : { createdAt: 'desc' };
    const [rows, total] = await Promise.all([
      this.db.message.findMany({ where, orderBy, take, skip, include: { sender: true } }),
      this.db.message.count({ where }),
    ]);
    const items: HistoryListItem[] = rows.map((r) => {
      const text = this.cipher.decrypt(r.currentText) ?? this.cipher.decrypt(r.currentCaption) ?? `[${r.type.toLowerCase()}]`;
      const s = r.sender;
      return {
        id: r.id,
        createdAt: r.createdAt,
        type: r.type,
        status: r.status,
        classification: r.classification,
        preview: text.replace(/\s+/g, ' ').slice(0, 60),
        userLabel: s ? (s.username ? `@${s.username}` : [s.firstName, s.lastName].filter(Boolean).join(' ') || `id ${s.telegramUserId}`) : '—',
        edited: r.versionCount > 1,
        deleted: r.deletedAt !== null,
      };
    });
    return { items, total };
  }

  async detail(messageId: number): Promise<MessageDetail | null> {
    const m = await this.db.message.findUnique({
      where: { id: messageId },
      include: { sender: true, chat: true, media: true, responses: { orderBy: { createdAt: 'asc' } }, attention: true },
    });
    if (!m) return null;
    return {
      id: m.id,
      chatId: m.chatId,
      telegramChatId: m.chat.telegramChatId,
      telegramMessageId: m.telegramMessageId,
      direction: m.direction,
      type: m.type,
      status: m.status,
      statusReason: m.statusReason,
      classification: m.classification,
      classificationConfidence: m.classificationConfidence,
      // Encrypted at rest (derived from message content); legacy plaintext rows stay readable.
      classificationReason: this.cipher.decrypt(m.classificationReason),
      injectionSuspected: m.injectionSuspected,
      telegramDate: m.telegramDate,
      editedAt: m.editedAt,
      deletedAt: m.deletedAt,
      sender: m.sender
        ? { telegramUserId: m.sender.telegramUserId, username: m.sender.username, firstName: m.sender.firstName, lastName: m.sender.lastName }
        : null,
      versions: await this.repo.versions(m.id),
      media: m.media.map((x) => ({
        kind: x.kind,
        status: x.status,
        fileName: x.fileName,
        extractedText: this.cipher.decrypt(x.extractedText),
        description: this.cipher.decrypt(x.description),
        error: x.error,
      })),
      responses: m.responses.map((r) => ({
        kind: r.kind,
        status: r.status,
        text: this.cipher.decrypt(r.text),
        provider: r.provider,
        model: r.model,
        reasoningEffort: r.reasoningEffort,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costUsd: Number(r.costUsd),
        latencyMs: r.latencyMs,
        usedFallback: r.usedFallback,
        createdAt: r.createdAt,
      })),
      attention: m.attention ? { id: m.attention.id, status: m.attention.status, reason: m.attention.reason } : null,
    };
  }
}
