import type { Db } from '../database/client.js';
import type { Chat, Message, MessageDirection, MessageStatus, TelegramUser } from '../generated/prisma/client.js';
import { Prisma } from '../generated/prisma/client.js';
import type { ContentCipher } from '../security/crypto.js';
import type { NormalizedMessage, NormalizedSender } from './types.js';

export interface StoredVersion {
  version: number;
  text: string | null;
  caption: string | null;
  editedAt: Date | null;
  createdAt: Date;
}

export interface DecryptedMessage extends Omit<Message, 'currentText' | 'currentCaption'> {
  currentText: string | null;
  currentCaption: string | null;
}

export interface HistoryTurn {
  messageId: number;
  telegramMessageId: number;
  direction: MessageDirection;
  text: string;
  date: Date;
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Persistence for users, chats, messages and versions.
 * All message content passes through ContentCipher (encrypted at rest when a key is configured).
 */
export class MessageRepository {
  constructor(
    private readonly db: Db,
    private readonly cipher: ContentCipher,
  ) {}

  decryptMessage<T extends Pick<Message, 'currentText' | 'currentCaption'>>(m: T): T {
    return { ...m, currentText: this.cipher.decrypt(m.currentText), currentCaption: this.cipher.decrypt(m.currentCaption) };
  }

  async upsertUser(sender: NormalizedSender): Promise<TelegramUser> {
    const data = {
      username: sender.username ?? null,
      firstName: sender.firstName ?? null,
      lastName: sender.lastName ?? null,
      languageCode: sender.languageCode ?? null,
      isBot: sender.isBot,
      ...(sender.accessHash !== undefined ? { accessHash: sender.accessHash } : {}),
      ...(sender.isContact !== undefined ? { isContact: sender.isContact } : {}),
    };
    return this.db.telegramUser.upsert({
      where: { telegramUserId: sender.telegramUserId },
      create: { telegramUserId: sender.telegramUserId, ...data },
      update: data,
    });
  }

  async upsertChat(connectionId: string, msg: NormalizedMessage, userId: number | null): Promise<Chat> {
    return this.db.chat.upsert({
      where: { connectionId_telegramChatId: { connectionId, telegramChatId: msg.chatId } },
      create: {
        connectionId,
        telegramChatId: msg.chatId,
        type: msg.chatType,
        title: msg.chatTitle ?? null,
        userId,
      },
      update: { ...(userId !== null ? { userId } : {}), ...(msg.chatTitle ? { title: msg.chatTitle } : {}) },
    });
  }

  async findChat(connectionId: string, telegramChatId: bigint): Promise<Chat | null> {
    return this.db.chat.findUnique({ where: { connectionId_telegramChatId: { connectionId, telegramChatId } } });
  }

  /**
   * Stores a new message with version 1 and its media rows.
   * Returns created=false when the same Telegram message was already stored (duplicate delivery).
   */
  async insertMessage(
    msg: NormalizedMessage,
    chat: Chat,
    senderId: number | null,
    direction: MessageDirection,
    status: MessageStatus,
    statusReason?: string,
  ): Promise<{ message: Message; created: boolean }> {
    const text = this.cipher.encrypt(msg.text ?? null);
    const caption = this.cipher.encrypt(msg.caption ?? null);
    try {
      const message = await this.db.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            chatId: chat.id,
            senderId,
            telegramMessageId: msg.telegramMessageId,
            direction,
            type: msg.type,
            currentText: text,
            currentCaption: caption,
            replyToTelegramMessageId: msg.replyToMessageId ?? null,
            forwardInfo: msg.forward
              ? { originType: msg.forward.originType, senderName: msg.forward.senderName ?? null, date: msg.forward.date?.toISOString() ?? null }
              : Prisma.JsonNull,
            mediaGroupId: msg.mediaGroupId ?? null,
            status,
            statusReason: statusReason ?? null,
            telegramDate: msg.date,
            editedAt: msg.editDate ?? null,
            versions: { create: { version: 1, text, caption, editedAt: msg.editDate ?? null } },
            media: {
              create: msg.media.map((m) => ({
                kind: m.kind,
                telegramFileId: m.fileId,
                telegramFileUniqueId: m.fileUniqueId,
                mimeType: m.mimeType ?? null,
                fileName: m.fileName ?? null,
                fileSize: m.fileSize ?? null,
                durationSec: m.durationSec ?? null,
                width: m.width ?? null,
                height: m.height ?? null,
                emoji: m.emoji ?? null,
                status: 'PENDING' as const,
              })),
            },
          },
        });
        const now = new Date();
        await tx.chat.update({
          where: { id: chat.id },
          data:
            direction === 'OUTGOING_OWNER'
              ? { lastMessageAt: now, lastOwnerMessageAt: now }
              : { lastMessageAt: now },
        });
        if (senderId !== null && direction === 'INCOMING') {
          await tx.telegramUser.update({
            where: { id: senderId },
            data: { messageCount: { increment: 1 }, lastMessageAt: now },
          });
        }
        return created;
      });
      return { message, created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.db.message.findUnique({
        where: { chatId_telegramMessageId: { chatId: chat.id, telegramMessageId: msg.telegramMessageId } },
      });
      if (!existing) throw error;
      return { message: existing, created: false };
    }
  }

  async findByTelegramId(chatId: number, telegramMessageId: number): Promise<Message | null> {
    return this.db.message.findUnique({ where: { chatId_telegramMessageId: { chatId, telegramMessageId } } });
  }

  async findById(id: number): Promise<Message | null> {
    return this.db.message.findUnique({ where: { id } });
  }

  /**
   * Appends a new version when text/caption changed. Returns null when nothing changed.
   * Uses the version counter under a row lock so concurrent edits cannot collide.
   */
  async appendVersion(
    messageId: number,
    newText: string | null,
    newCaption: string | null,
    editedAt: Date,
  ): Promise<{ previous: StoredVersion; current: StoredVersion } | null> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM messages WHERE id = ${messageId} FOR UPDATE`;
      const msg = await tx.message.findUniqueOrThrow({ where: { id: messageId } });
      const last = await tx.messageVersion.findFirst({ where: { messageId }, orderBy: { version: 'desc' } });
      const prevText = this.cipher.decrypt(last?.text ?? msg.currentText);
      const prevCaption = this.cipher.decrypt(last?.caption ?? msg.currentCaption);
      if ((prevText ?? null) === (newText ?? null) && (prevCaption ?? null) === (newCaption ?? null)) return null;

      const version = (last?.version ?? 0) + 1;
      const encText = this.cipher.encrypt(newText);
      const encCaption = this.cipher.encrypt(newCaption);
      const created = await tx.messageVersion.create({
        data: { messageId, version, text: encText, caption: encCaption, editedAt },
      });
      await tx.message.update({
        where: { id: messageId },
        data: { currentText: encText, currentCaption: encCaption, editedAt, versionCount: version },
      });
      return {
        previous: {
          version: last?.version ?? 1,
          text: prevText,
          caption: prevCaption,
          editedAt: last?.editedAt ?? null,
          createdAt: last?.createdAt ?? msg.createdAt,
        },
        current: { version, text: newText, caption: newCaption, editedAt, createdAt: created.createdAt },
      };
    });
  }

  async versions(messageId: number): Promise<StoredVersion[]> {
    const rows = await this.db.messageVersion.findMany({ where: { messageId }, orderBy: { version: 'asc' } });
    return rows.map((r) => ({
      version: r.version,
      text: this.cipher.decrypt(r.text),
      caption: this.cipher.decrypt(r.caption),
      editedAt: r.editedAt,
      createdAt: r.createdAt,
    }));
  }

  async markDeleted(chatId: number, telegramMessageIds: number[], deletedAt: Date): Promise<Message[]> {
    const found = await this.db.message.findMany({
      where: { chatId, telegramMessageId: { in: telegramMessageIds }, deletedAt: null },
    });
    if (found.length > 0) {
      await this.db.message.updateMany({ where: { id: { in: found.map((m) => m.id) } }, data: { deletedAt } });
    }
    return found.map((m) => ({ ...m, deletedAt }));
  }

  async setStatus(messageId: number, status: MessageStatus, reason?: string): Promise<void> {
    await this.db.message.update({
      where: { id: messageId },
      data: { status, statusReason: reason ?? null, ...(status !== 'QUEUED' && status !== 'PROCESSING' ? { processedAt: new Date() } : {}) },
    });
  }

  /**
   * Recent conversation turns (oldest first) for AI context. Includes owner and bot replies,
   * plus media-derived text (transcripts/descriptions) so later turns can refer to them.
   */
  async recentHistory(chatId: number, limit: number, beforeMessageId?: number): Promise<HistoryTurn[]> {
    const rows = await this.db.message.findMany({
      where: { chatId, ...(beforeMessageId ? { id: { lt: beforeMessageId } } : {}) },
      orderBy: { telegramDate: 'desc' },
      take: limit,
      include: { media: { select: { kind: true, extractedText: true, description: true } } },
    });
    return rows.reverse().map((r) => {
      const parts: string[] = [];
      const text = this.cipher.decrypt(r.currentText);
      const caption = this.cipher.decrypt(r.currentCaption);
      if (text) parts.push(text);
      if (caption) parts.push(caption);
      for (const m of r.media) {
        const extracted = this.cipher.decrypt(m.extractedText);
        const description = this.cipher.decrypt(m.description);
        if (extracted) parts.push(`[${m.kind.toLowerCase()} transcript/text] ${extracted.slice(0, 600)}`);
        if (description) parts.push(`[${m.kind.toLowerCase()} description] ${description.slice(0, 600)}`);
        if (!extracted && !description) parts.push(`[${m.kind.toLowerCase()}]`);
      }
      if (r.deletedAt) parts.push('(this message was later deleted by the sender)');
      return {
        messageId: r.id,
        telegramMessageId: r.telegramMessageId,
        direction: r.direction,
        text: parts.join('\n').slice(0, 2000),
        date: r.telegramDate,
      };
    });
  }

  /** Incoming messages in the chat after `messageId` (used by debounce to answer bursts once). */
  async newerIncomingExists(chatId: number, messageId: number): Promise<boolean> {
    const count = await this.db.message.count({
      where: {
        chatId,
        id: { gt: messageId },
        direction: 'INCOMING',
        deletedAt: null,
        status: { in: ['QUEUED', 'PROCESSING', 'RECEIVED'] },
      },
    });
    return count > 0;
  }

  private async lastOutgoingIdBefore(chatId: number, messageId: number): Promise<number | null> {
    const lastOutgoing = await this.db.message.findFirst({
      where: { chatId, direction: { in: ['OUTGOING_BOT', 'OUTGOING_OWNER'] }, id: { lt: messageId } },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    return lastOutgoing?.id ?? null;
  }

  /**
   * Unanswered incoming messages since the last outgoing message (burst to answer together):
   * the NEWEST `limit` pending (QUEUED/RECEIVED, not deleted) messages up to and including
   * `uptoMessageId`, oldest first. PROCESSING rows belong to the current lease holder and are
   * never selectable by another job.
   */
  async pendingBurst(chatId: number, uptoMessageId: number, limit = 10): Promise<Message[]> {
    const lastOutgoingId = await this.lastOutgoingIdBefore(chatId, uptoMessageId);
    const rows = await this.db.message.findMany({
      where: {
        chatId,
        direction: 'INCOMING',
        deletedAt: null,
        id: { lte: uptoMessageId, ...(lastOutgoingId !== null ? { gt: lastOutgoingId } : {}) },
        status: { in: ['QUEUED', 'RECEIVED'] },
      },
      orderBy: { id: 'desc' },
      take: limit,
    });
    return rows.reverse();
  }

  /**
   * Pending messages of the same burst that are older than the answered window (more than
   * `limit` messages in a burst): they are superseded by the newer ones and must not stay QUEUED.
   */
  async skipOlderPending(chatId: number, beforeMessageId: number, uptoMessageId: number, reason: string): Promise<number> {
    const lastOutgoingId = await this.lastOutgoingIdBefore(chatId, uptoMessageId);
    const result = await this.db.message.updateMany({
      where: {
        chatId,
        direction: 'INCOMING',
        id: { lt: beforeMessageId, ...(lastOutgoingId !== null ? { gt: lastOutgoingId } : {}) },
        status: { in: ['QUEUED', 'RECEIVED'] },
      },
      data: { status: 'SKIPPED', statusReason: reason.slice(0, 200), processedAt: new Date() },
    });
    return result.count;
  }

  /** Newest pending (QUEUED/RECEIVED, not deleted) incoming message older than `beforeMessageId`. */
  async latestPendingBefore(chatId: number, beforeMessageId: number): Promise<Message | null> {
    return this.db.message.findFirst({
      where: { chatId, direction: 'INCOMING', deletedAt: null, id: { lt: beforeMessageId }, status: { in: ['QUEUED', 'RECEIVED'] } },
      orderBy: { id: 'desc' },
    });
  }

  /**
   * PROCESSING rows left behind by a holder whose chat lease expired (crash / stalled worker) go
   * back to QUEUED. Call only while holding the chat lease: then no live holder owns them.
   */
  async recoverOrphanedProcessing(chatId: number): Promise<number> {
    const result = await this.db.message.updateMany({
      where: { chatId, direction: 'INCOMING', status: 'PROCESSING' },
      data: { status: 'QUEUED' },
    });
    return result.count;
  }

  /** The owner wrote in the chat after the burst started (a stored owner message or lastOwnerMessageAt). */
  async ownerRepliedSince(chatId: number, afterMessageId: number, since: Date): Promise<boolean> {
    const count = await this.db.message.count({ where: { chatId, direction: 'OUTGOING_OWNER', id: { gt: afterMessageId } } });
    if (count > 0) return true;
    const chat = await this.db.chat.findUnique({ where: { id: chatId }, select: { lastOwnerMessageAt: true } });
    return !!chat?.lastOwnerMessageAt && chat.lastOwnerMessageAt.getTime() > since.getTime();
  }

  /** Incoming messages of the sender since `since`, not counting `excludeIds` (the burst being handled). */
  async countIncomingSince(senderId: number, since: Date, excludeIds: number[] = []): Promise<number> {
    return this.db.message.count({
      where: { senderId, direction: 'INCOMING', createdAt: { gte: since }, ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}) },
    });
  }

  /**
   * Every AI call (reply, classifier, vision, transcription, video, TTS…, successful or not)
   * attributed to messages of this chat since `since` (usage_stats.messageId → messages.chatId).
   */
  async aiCallsForChatSince(chatId: number, since: Date): Promise<number> {
    const rows = await this.db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n
        FROM usage_stats u
        JOIN messages m ON m.id = u."messageId"
       WHERE m."chatId" = ${chatId} AND u."createdAt" >= ${since}`;
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Newest pending incoming message per chat that arrived before `olderThan` and whose chat has
   * no QUEUED/RUNNING `message.process` job (orphaned: nothing will ever answer it otherwise).
   * PROCESSING rows count as pending only when their chat lease is free/expired (holder died).
   */
  async orphanedPendingMessages(olderThan: Date, limit: number): Promise<Array<{ id: number; chatId: number; hasPendingMedia: boolean }>> {
    return this.db.$queryRaw<Array<{ id: number; chatId: number; hasPendingMedia: boolean }>>`
      SELECT DISTINCT ON (m."chatId") m.id, m."chatId",
             EXISTS (SELECT 1 FROM media md WHERE md."messageId" = m.id AND md.status = 'PENDING' AND md.kind <> 'STICKER') AS "hasPendingMedia"
        FROM messages m
        JOIN chats c ON c.id = m."chatId"
       WHERE m.direction = 'INCOMING'
         AND (m.status IN ('QUEUED', 'RECEIVED')
              OR (m.status = 'PROCESSING' AND (c."processingUntil" IS NULL OR c."processingUntil" < now())))
         AND m."createdAt" < ${olderThan}
         AND NOT EXISTS (
               SELECT 1
                 FROM jobs j
                 JOIN messages m2
                   ON m2.id = CASE WHEN (j.payload->>'messageId') ~ '^[0-9]{1,9}$' THEN (j.payload->>'messageId')::int END
                WHERE j.type = 'message.process' AND j.status IN ('QUEUED', 'RUNNING') AND m2."chatId" = m."chatId")
       ORDER BY m."chatId", m.id DESC
       LIMIT ${limit}`;
  }
}
