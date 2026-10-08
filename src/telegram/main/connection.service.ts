import type { Api } from 'grammy';
import type { BusinessConnection } from 'grammy/types';
import type { Db } from '../../database/client.js';
import type { TelegramConnection } from '../../generated/prisma/client.js';
import type { EventLog } from '../../logging/events.js';
import { childLogger } from '../../logging/logger.js';
import { describeError } from '../../logging/sanitize.js';
import { currentTenant, currentTenantId, currentTenantOrNull } from '../../tenancy/context.js';
import type { AdminNotifier } from '../admin/notifier.js';

const log = childLogger('connections');

/** Bot API ≥ 9.0 exposes `rights.can_reply`; older versions had a top-level `can_reply`. */
function canReplyOf(bc: BusinessConnection): boolean {
  const withRights = bc as BusinessConnection & { rights?: { can_reply?: boolean }; can_reply?: boolean };
  return Boolean(withRights.rights?.can_reply ?? withRights.can_reply ?? false);
}

/**
 * Tracks Telegram Business / userbot connections. A connection is authorized only when it belongs to
 * the current (active) tenant: the tenant scope is resolved from the connection's owner before any
 * handler runs (src/tenancy/bot-scope.ts), so connections of unknown accounts are never stored.
 */
export class ConnectionService {
  /** Keyed by `<tenantId>:<connectionId>`. */
  private cache = new Map<string, { conn: TelegramConnection; at: number }>();

  constructor(
    private readonly db: Db,
    private readonly api: Api,
    private readonly notifier: AdminNotifier,
    private readonly events: EventLog,
  ) {}

  private key(connectionId: string): string {
    return `${currentTenantId('connections')}:${connectionId}`;
  }

  /** Stores a business connection of the current tenant; ignored (null) outside a tenant scope. */
  async upsertFromUpdate(bc: BusinessConnection): Promise<TelegramConnection | null> {
    const tenant = currentTenantOrNull();
    const ownerUserId = BigInt(bc.user.id);
    if (!tenant || tenant.ownerTelegramUserId !== ownerUserId) {
      await this.events.warn('connections', 'business connection from an account without an active workspace ignored');
      log.warn({ connectionId: '[hidden]' }, 'business connection from an unknown account ignored');
      return null;
    }
    const authorized = true;
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
    this.cache.set(this.key(conn.id), { conn, at: Date.now() });
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
   * The current tenant's connection, fetched from Telegram when unknown (e.g. after a DB reset).
   * Authorization is re-derived on every read: only the tenant owner's own account is authorized.
   */
  async get(connectionId: string): Promise<TelegramConnection | null> {
    const conn = await this.load(connectionId);
    if (!conn) return null;
    const authorized = conn.ownerUserId === currentTenant('connections').ownerTelegramUserId;
    return authorized === conn.authorized ? conn : { ...conn, authorized };
  }

  /** Pseudo-connection for the userbot (MTProto) transport: `userbot:<ownerUserId>`. */
  async ensureUserbotConnection(ownerUserId: bigint): Promise<TelegramConnection> {
    const id = `userbot:${ownerUserId}`;
    const authorized = ownerUserId === currentTenant('connections').ownerTelegramUserId;
    const data = { ownerUserId, userChatId: ownerUserId, isEnabled: true, canReply: true, authorized, connectedAt: new Date() };
    const conn = await this.db.telegramConnection.upsert({ where: { id }, create: { id, ...data }, update: data });
    this.cache.set(this.key(id), { conn, at: Date.now() });
    if (!authorized) await this.events.warn('connections', 'userbot account is not the workspace owner; messages ignored');
    return conn;
  }

  private async load(connectionId: string): Promise<TelegramConnection | null> {
    const key = this.key(connectionId);
    const cached = this.cache.get(key);
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
      if (!conn) return null;
    }
    this.cache.set(key, { conn, at: Date.now() });
    return conn;
  }

  async listAuthorized(): Promise<TelegramConnection[]> {
    return this.db.telegramConnection.findMany({ where: { authorized: true }, orderBy: { updatedAt: 'desc' } });
  }
}
