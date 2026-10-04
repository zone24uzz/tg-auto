import type { AuditService } from '../audit/audit.service.js';
import type { Db } from '../database/client.js';
import type { StorageDriver } from '../media/storage/storage.js';
import type { Settings } from '../settings/schema.js';

export interface PrivacyOverview {
  encryptionAtRest: boolean;
  messageRetentionDays: number;
  mediaRetentionDays: number;
  aiLogRetentionDays: number;
  retainRawMedia: boolean;
  storedMessages: number;
  storedUsers: number;
  storedMediaFiles: number;
  oldestMessageAt: Date | null;
  /** An (encrypted) MTProto userbot session with full account access is stored. */
  userbotSessionStored?: boolean;
}

/** Privacy overview and per-user / per-chat data deletion (admin only). */
export class PrivacyService {
  constructor(
    private readonly db: Db,
    private readonly storage: StorageDriver,
    private readonly audit: AuditService,
    private readonly encryptionEnabled: boolean,
  ) {}

  async overview(settings: Settings): Promise<PrivacyOverview> {
    const [storedMessages, storedUsers, storedMediaFiles, oldest, userbotSessions] = await Promise.all([
      this.db.message.count(),
      this.db.telegramUser.count(),
      this.db.media.count({ where: { storageKey: { not: null } } }),
      this.db.message.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      this.db.userbotSession.count(),
    ]);
    return {
      encryptionAtRest: this.encryptionEnabled,
      messageRetentionDays: settings.messageRetentionDays,
      mediaRetentionDays: settings.mediaRetentionDays,
      aiLogRetentionDays: settings.aiLogRetentionDays,
      retainRawMedia: settings.retainRawMedia,
      storedMessages,
      storedUsers,
      storedMediaFiles,
      oldestMessageAt: oldest?.createdAt ?? null,
      userbotSessionStored: userbotSessions > 0,
    };
  }

  /** Deletes every stored message, media file, summary and profile of a contact. Rules are kept. */
  async deleteUserData(telegramUserId: bigint, adminTelegramUserId: bigint): Promise<{ messages: number; chats: number }> {
    const user = await this.db.telegramUser.findUnique({ where: { telegramUserId } });
    const chats = await this.db.chat.findMany({
      where: { OR: [{ telegramChatId: telegramUserId }, ...(user ? [{ userId: user.id }] : [])] },
      select: { id: true },
    });
    const result = await this.deleteChats(chats.map((c) => c.id));
    if (user) await this.db.telegramUser.delete({ where: { id: user.id } }).catch(() => undefined);
    await this.audit.record(adminTelegramUserId, 'DATA_DELETED', `user:${telegramUserId}`, result);
    return result;
  }

  async deleteChatData(chatId: number, adminTelegramUserId: bigint): Promise<{ messages: number; chats: number }> {
    const result = await this.deleteChats([chatId]);
    await this.audit.record(adminTelegramUserId, 'DATA_DELETED', `chat:${chatId}`, result);
    return result;
  }

  private async deleteChats(chatIds: number[]): Promise<{ messages: number; chats: number }> {
    if (chatIds.length === 0) return { messages: 0, chats: 0 };
    const files = await this.db.media.findMany({
      where: { message: { chatId: { in: chatIds } }, storageKey: { not: null } },
      select: { storageKey: true },
    });
    for (const f of files) if (f.storageKey) await this.storage.delete(f.storageKey).catch(() => undefined);
    const messages = await this.db.message.count({ where: { chatId: { in: chatIds } } });
    // Cascades: messages → versions, media, responses, attention; chat → summary.
    const chats = await this.db.chat.deleteMany({ where: { id: { in: chatIds } } });
    return { messages, chats: chats.count };
  }
}
