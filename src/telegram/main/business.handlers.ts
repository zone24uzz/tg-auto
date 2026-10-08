import type { BusinessMessagesDeleted, Message as TgMessage } from 'grammy/types';
import type { Db } from '../../database/client.js';
import type { Chat, Message } from '../../generated/prisma/client.js';
import type { EventLog } from '../../logging/events.js';
import { childLogger } from '../../logging/logger.js';
import type { MessageRepository } from '../../messages/message.repository.js';
import { primaryText, type NormalizedMessage, type NormalizedSender } from '../../messages/types.js';
import type { OwnerAttentionService } from '../../owner-attention/attention.service.js';
import type { PgQueue } from '../../queues/pg-queue.js';
import { findMatchingRule } from '../../rules/rules.engine.js';
import type { RulesService } from '../../rules/rules.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { displayUser } from '../common/html.js';
import type { AdminNotifier } from '../admin/notifier.js';
import type { ConnectionService } from './connection.service.js';
import { normalizeBusinessMessage } from './normalizer.js';

const log = childLogger('business');
const MAX_DELETE_NOTIFICATIONS = 5;
/** Edit/delete notifications per chat per window (a contact cannot flood the owner's admin chat). */
const NOTIFY_LIMIT = 5;
const NOTIFY_WINDOW_MS = 10 * 60_000;

export interface BusinessHandlerDeps {
  db: Db;
  repo: MessageRepository;
  connections: ConnectionService;
  settings: SettingsService;
  rules: RulesService;
  queue: PgQueue;
  attention: OwnerAttentionService;
  notifier: AdminNotifier;
  events: EventLog;
  logMessageContent: boolean;
  /** Owner's assistant: "tell me when X writes" watches (never blocks ingestion). */
  assistant?: { onIncomingMessage(info: { telegramUserId: bigint; label: string; preview: string }): Promise<void> };
}

/**
 * Ingests messages from either transport (Telegram Business bot updates or the userbot/MTProto
 * client, both already normalized): stores every authorized message first, so later edits and
 * deletions can be compared, then enqueues the reply job.
 */
export class BusinessHandlers {
  private notifyLog = new Map<number, number[]>();

  constructor(private readonly d: BusinessHandlerDeps) {}

  // ── Bot API (Telegram Business) adapters ───────────────────────────────

  async onMessage(raw: TgMessage): Promise<void> {
    const msg = normalizeBusinessMessage(raw);
    if (msg) await this.handleIncoming(msg);
  }

  async onEdited(raw: TgMessage): Promise<void> {
    const msg = normalizeBusinessMessage(raw);
    if (msg) await this.handleEdit(msg);
  }

  async onDeleted(event: BusinessMessagesDeleted): Promise<void> {
    const chat = event.chat;
    await this.handleDeleted(event.business_connection_id, BigInt(chat.id), event.message_ids, {
      username: 'username' in chat ? chat.username : undefined,
      firstName: 'first_name' in chat ? chat.first_name : undefined,
      lastName: 'last_name' in chat ? chat.last_name : undefined,
    });
  }

  // ── transport-independent handlers ─────────────────────────────────────

  async handleIncoming(msg: NormalizedMessage): Promise<void> {
    const conn = await this.d.connections.get(msg.connectionId);
    if (!conn || !conn.authorized) {
      log.warn('message from an unauthorized/unknown connection ignored');
      return;
    }
    if (msg.chatType !== 'private') return;

    const isOwner = msg.sender?.telegramUserId === conn.ownerUserId;
    if (isOwner || msg.sentByBusinessBot) {
      // Outgoing message from the account (the owner typed it, or a bot/this system sent it).
      const chat = await this.d.repo.upsertChat(conn.id, msg, null);
      await this.d.repo.insertMessage(msg, chat, null, msg.sentByBusinessBot ? 'OUTGOING_BOT' : 'OUTGOING_OWNER', 'ANSWERED');
      if (isOwner && !msg.sentByBusinessBot) await this.ownerIsHandling(chat);
      return;
    }
    if (!msg.sender || msg.sender.isBot) return;

    const settings = await this.d.settings.get();
    const active = SettingsService.isAutoReplyActive(settings);
    if (!active && !settings.logWhenDisabled) {
      await this.watchHook(msg, msg.sender);
      return;
    }

    const user = await this.d.repo.upsertUser(msg.sender);
    const chat = await this.d.repo.upsertChat(conn.id, msg, user.id);

    // Blocked / ignored senders are stored (for edit/delete tracking) but never queued.
    const rule = findMatchingRule(await this.d.rules.all(), {
      telegramUserId: user.telegramUserId,
      username: user.username,
      chatId: chat.telegramChatId,
      tags: user.tags,
      isNewChat: chat.lastOwnerMessageAt === null,
      isContact: user.isContact,
    });
    const hardStop = rule?.mode === 'BLOCK' || rule?.mode === 'IGNORE';
    const status = hardStop ? 'IGNORED' : active ? 'QUEUED' : 'SKIPPED';
    const reason = hardStop ? `rule:${rule!.mode.toLowerCase()}` : active ? undefined : 'auto-reply disabled';

    const { message, created } = await this.d.repo.insertMessage(msg, chat, user.id, 'INCOMING', status, reason);
    if (created) {
      await this.watchHook(msg, msg.sender);
      log.info(
        {
          messageId: message.id,
          chatId: chat.id,
          type: msg.type,
          ...(this.d.logMessageContent ? { text: msg.text?.slice(0, 200) } : {}),
        },
        'message stored',
      );
      if (status !== 'QUEUED') {
        if (!active && settings.notifyWhenDisabled && !hardStop)
          await this.d.notifier.text(`📩 Avtojavob o‘chiq paytda yangi xabar: ${displayUser(user).replace(/[<>&]/g, '')}`);
        return;
      }
    } else if (message.status !== 'QUEUED') {
      return; // duplicate delivery of an already handled message
    }

    // Also runs for a redelivered QUEUED message whose job was never created (crash between
    // store and enqueue); the dedupe key makes the enqueue idempotent.
    const needsMedia = msg.media.some((m) => m.kind !== 'STICKER');
    await this.d.queue.enqueue(
      needsMedia ? 'media' : 'text',
      'message.process',
      { messageId: message.id },
      { runAt: new Date(Date.now() + settings.debounceSeconds * 1000), dedupeKey: `msg:${message.id}`, maxAttempts: 3 },
    );
  }

  async handleEdit(msg: NormalizedMessage): Promise<void> {
    const conn = await this.d.connections.get(msg.connectionId);
    if (!conn || !conn.authorized || msg.chatType !== 'private') return;

    const isOwner = msg.sender?.telegramUserId === conn.ownerUserId;
    const user = !isOwner && msg.sender ? await this.d.repo.upsertUser(msg.sender) : null;
    const chat = await this.d.repo.upsertChat(conn.id, msg, user?.id ?? null);
    const existing = await this.d.repo.findByTelegramId(chat.id, msg.telegramMessageId);
    if (!existing) {
      // We never saw the original (sent before tracking started): store the edited text as-is.
      await this.d.repo.insertMessage(
        msg,
        chat,
        user?.id ?? null,
        isOwner ? 'OUTGOING_OWNER' : 'INCOMING',
        'SKIPPED',
        'edit of a message received before tracking',
      );
      return;
    }
    const diff = await this.d.repo.appendVersion(existing.id, msg.text ?? null, msg.caption ?? null, msg.editDate ?? new Date());
    if (!diff) return;
    const settings = await this.d.settings.get();
    if (existing.direction !== 'INCOMING' || !settings.notifyEdits || !user) return;
    if (!(await this.mayNotify(chat))) return;
    await this.d.notifier.messageEdited({
      userLabel: displayUser(user),
      editedAt: diff.current.editedAt ?? new Date(),
      oldText: diff.previous.text ?? diff.previous.caption,
      newText: diff.current.text ?? diff.current.caption,
      versionNumber: diff.current.version,
    });
  }

  /** Deletion with a known chat (Telegram Business `deleted_business_messages`). */
  async handleDeleted(
    connectionId: string,
    telegramChatId: bigint,
    messageIds: number[],
    who: { username?: string; firstName?: string; lastName?: string } = {},
  ): Promise<void> {
    const conn = await this.d.connections.get(connectionId);
    if (!conn || !conn.authorized) return;
    const deletedAt = new Date();
    const chat = await this.d.repo.findChat(conn.id, telegramChatId);
    const label = displayUser({ ...who, telegramUserId: telegramChatId });
    const settings = await this.d.settings.get();
    if (!chat) {
      if (settings.notifyDeletes) await this.d.notifier.deletedUnknown({ userLabel: label, count: messageIds.length, deletedAt });
      return;
    }
    const found = await this.d.repo.markDeleted(chat.id, messageIds, deletedAt);
    const known = await this.d.db.message.count({ where: { chatId: chat.id, telegramMessageId: { in: messageIds } } });
    await this.reportDeleted(chat, found, messageIds.length - known, label, deletedAt);
  }

  /**
   * Deletion without a chat id (MTProto `UpdateDeleteMessages` for private chats only carries ids,
   * which are unique per account): matches stored messages of this connection by id.
   */
  async handleDeletedIds(connectionId: string, messageIds: number[]): Promise<void> {
    const conn = await this.d.connections.get(connectionId);
    if (!conn || !conn.authorized || messageIds.length === 0) return;
    const deletedAt = new Date();
    const rows = await this.d.db.message.findMany({
      where: { telegramMessageId: { in: messageIds }, chat: { connectionId: conn.id }, deletedAt: null },
      select: { chatId: true },
      distinct: ['chatId'],
    });
    for (const { chatId } of rows) {
      const chat = await this.d.db.chat.findUnique({ where: { id: chatId }, include: { user: true } });
      if (!chat) continue;
      const found = await this.d.repo.markDeleted(chat.id, messageIds, deletedAt);
      const label = chat.user ? displayUser(chat.user) : displayUser({ telegramUserId: chat.telegramChatId });
      await this.reportDeleted(chat, found, 0, label, deletedAt);
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────

  /** `unknownCount` = deleted ids that were never stored (sent before tracking started). */
  private async reportDeleted(chat: Chat, found: Message[], unknownCount: number, label: string, deletedAt: Date): Promise<void> {
    await this.d.events.info('business', `${found.length} deleted messages matched in chat ${chat.id} (${unknownCount} unknown)`);
    const settings = await this.d.settings.get();
    if (!settings.notifyDeletes || (await this.isMuted(chat))) return;

    const incoming = found.filter((m) => m.direction === 'INCOMING');
    let notified = 0;
    for (const m of incoming.slice(0, MAX_DELETE_NOTIFICATIONS)) {
      if (!(await this.mayNotify(chat))) break;
      const versions = await this.d.repo.versions(m.id);
      await this.d.notifier.messageDeleted({
        userLabel: label,
        writtenAt: m.telegramDate,
        deletedAt,
        versions: versions.map((v) => ({ version: v.version, text: v.text ?? (m.type !== 'TEXT' ? `[${m.type.toLowerCase()}]` : null), caption: v.caption })),
        messageId: m.id,
      });
      notified++;
    }
    if (unknownCount > 0 && (await this.mayNotify(chat)))
      await this.d.notifier.deletedUnknown({ userLabel: label, count: unknownCount, deletedAt });
    if (incoming.length > notified) log.info({ chatId: chat.id, skipped: incoming.length - notified }, 'delete notifications throttled');
  }

  /** The owner wrote personally: close attention items and stop pending auto replies in this chat. */
  /** Owner's "tell me when X writes" watches; runs once per stored message and never throws. */
  private async watchHook(msg: NormalizedMessage, sender: NormalizedSender): Promise<void> {
    if (!this.d.assistant) return;
    const name = [sender.firstName, sender.lastName].filter(Boolean).join(' ').trim();
    const label = name || (sender.username ? `@${sender.username}` : `id ${sender.telegramUserId}`);
    const preview = primaryText(msg) || (msg.media[0] ? `[${msg.media[0].kind.toLowerCase()}]` : '[xabar]');
    try {
      await this.d.assistant.onIncomingMessage({ telegramUserId: sender.telegramUserId, label, preview });
    } catch (error) {
      log.warn({ err: error }, 'assistant message watch failed');
    }
  }

  private async ownerIsHandling(chat: Chat): Promise<void> {
    const resolved = await this.d.attention.resolveByOwnerReply(chat.id);
    const stopped = await this.d.db.message.updateMany({
      where: { chatId: chat.id, direction: 'INCOMING', status: 'QUEUED' },
      data: { status: 'MANUAL', statusReason: 'owner replied personally', processedAt: new Date() },
    });
    if (resolved > 0 || stopped.count > 0) log.info({ chatId: chat.id, resolved, stopped: stopped.count }, 'owner is handling the chat');
  }

  /** BLOCK/IGNORE contacts never generate notifications. */
  private async isMuted(chat: Chat): Promise<boolean> {
    const user = chat.userId ? await this.d.db.telegramUser.findUnique({ where: { id: chat.userId } }) : null;
    const rule = findMatchingRule(await this.d.rules.all(), {
      telegramUserId: user?.telegramUserId ?? chat.telegramChatId,
      username: user?.username,
      chatId: chat.telegramChatId,
      tags: user?.tags ?? [],
      isNewChat: false,
    });
    return rule?.mode === 'BLOCK' || rule?.mode === 'IGNORE';
  }

  private async mayNotify(chat: Chat): Promise<boolean> {
    if (await this.isMuted(chat)) return false;
    const now = Date.now();
    const recent = (this.notifyLog.get(chat.id) ?? []).filter((t) => now - t < NOTIFY_WINDOW_MS);
    if (recent.length >= NOTIFY_LIMIT) {
      this.notifyLog.set(chat.id, recent);
      return false;
    }
    recent.push(now);
    this.notifyLog.set(chat.id, recent);
    return true;
  }
}
