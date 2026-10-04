import type { Api } from 'grammy';
import type { BusinessConnection } from 'grammy/types';
import type { Db } from '../../database/client.js';
import type { TelegramConnection } from '../../generated/prisma/client.js';
import type { EventLog } from '../../logging/events.js';
import { childLogger } from '../../logging/logger.js';
import { describeError } from '../../logging/sanitize.js';
import type { AdminNotifier } from '../admin/notifier.js';

const log = childLogger('connections');

/** Bot API ≥ 9.0 exposes `rights.can_reply`; older versions had a top-level `can_reply`. */
function canReplyOf(bc: BusinessConnection): boolean {
  const withRights = bc as BusinessConnection & { rights?: { can_reply?: boolean }; can_reply?: boolean };
  return Boolean(withRights.rights?.can_reply ?? withRights.can_reply ?? false);
}

/**
 * Tracks Telegram Business connections. Only connections created by the configured owner
 * (ADMIN_TELEGRAM_USER_ID) are authorized; messages from any other connection are ignored.
 */
export class ConnectionService {
  private cache = new Map<string, { conn: TelegramConnection; at: number }>();

  constructor(
    private readonly db: Db,
    private readonly api: Api,
    private readonly ownerId: bigint,
    private readonly notifier: AdminNotifier,
    private readonly events: EventLog,
  ) {}

  async upsertFromUpdate(bc: BusinessConnection): Promise<TelegramConnection> {
    const ownerUserId = BigInt(bc.user.id);
    const authorized = ownerUserId === this.ownerId;
    const data = {
      ownerUserId,
      userChatId: BigInt(bc.user_chat_id),
      isEnabled: bc.is_enabled,
      canReply: canReplyOf(bc),
      authorized,
      rights: ((bc as BusinessConnection & { rights?: object }).rights ?? null) as never,
      connectedAt: new Date(bc.date * 1000),
    };
    const before = await this.db.telegramConnection.findUnique({ where: { id: bc.id } });
    const conn = await this.db.telegramConnection.upsert({ where: { id: bc.id }, create: { id: bc.id, ...data }, update: data });
    this.cache.set(conn.id, { conn, at: Date.now() });

    if (!authorized) {
      await this.events.warn('connections', `unauthorized business connection from user ${ownerUserId} ignored`);
      log.warn({ connectionId: '[hidden]' }, 'business connection from a non-owner account ignored');
      return conn;
    }
    const changed = !before || before.isEnabled !== conn.isEnabled || before.canReply !== conn.canReply;
    if (changed) {
      const status = !conn.isEnabled
        ? '🔴 Telegram Business ulanishi o‘chirildi. Avtojavoblar to‘xtadi.'
        : conn.canReply
          ? '🟢 Telegram Business ulandi. Bot xabarlarni qabul qiladi va javob bera oladi.'
          : '🟡 Telegram Business ulandi, lekin botga «javob berish» huquqi berilmagan. Telegram → Sozlamalar → Telegram Business → Chatbotlar bo‘limida ruxsat bering.';
      await this.notifier.text(status);
      await this.events.info('connections', `connection ${conn.isEnabled ? 'enabled' : 'disabled'}, canReply=${conn.canReply}`);
    }
    return conn;
  }

  /**
   * Returns the connection, fetching it from Telegram when unknown (e.g. after a DB reset).
   * Authorization is re-derived from the CURRENT owner id on every read, so changing
   * ADMIN_TELEGRAM_USER_ID immediately de-authorizes an old owner's connection.
   */
  async get(connectionId: string): Promise<TelegramConnection | null> {
    const conn = await this.load(connectionId);
    if (!conn) return null;
    const authorized = conn.ownerUserId === this.ownerId;
    return authorized === conn.authorized ? conn : { ...conn, authorized };
  }

  /** Pseudo-connection for the userbot (MTProto) transport: `userbot:<ownerUserId>`. */
  async ensureUserbotConnection(ownerUserId: bigint): Promise<TelegramConnection> {
    const id = `userbot:${ownerUserId}`;
    const authorized = ownerUserId === this.ownerId;
    const data = { ownerUserId, userChatId: ownerUserId, isEnabled: true, canReply: true, authorized, connectedAt: new Date() };
    const conn = await this.db.telegramConnection.upsert({ where: { id }, create: { id, ...data }, update: data });
    this.cache.set(id, { conn, at: Date.now() });
    if (!authorized) await this.events.warn('connections', `userbot account ${ownerUserId} is not ADMIN_TELEGRAM_USER_ID; messages ignored`);
    return conn;
  }

  private async load(connectionId: string): Promise<TelegramConnection | null> {
    const cached = this.cache.get(connectionId);
    if (cached && Date.now() - cached.at < 60_000) return cached.conn;
    let conn = await this.db.telegramConnection.findUnique({ where: { id: connectionId } });
    if (!conn && connectionId.startsWith('userbot:')) return null;
    if (!conn) {
      try {
        const bc = await this.api.getBusinessConnection(connectionId);
        conn = await this.upsertFromUpdate(bc);
      } catch (error) {
        log.warn({ error: describeError(error) }, 'could not fetch business connection');
        return null;
      }
    }
    this.cache.set(connectionId, { conn, at: Date.now() });
    return conn;
  }

  async listAuthorized(): Promise<TelegramConnection[]> {
    return this.db.telegramConnection.findMany({ where: { authorized: true }, orderBy: { updatedAt: 'desc' } });
  }
}
