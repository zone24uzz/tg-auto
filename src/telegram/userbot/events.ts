import { Api, type TelegramClient } from 'telegram';
import { DeletedMessage, type DeletedMessageEvent } from 'telegram/events/DeletedMessage.js';
import { EditedMessage, type EditedMessageEvent } from 'telegram/events/EditedMessage.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { childLogger } from '../../logging/logger.js';
import { describeError } from '../../logging/sanitize.js';
import type { NormalizedMessage, NormalizedSender } from '../../messages/types.js';
import type { BusinessHandlers } from '../main/business.handlers.js';
import { TELEGRAM_SERVICE_USER_ID, normalizeMtprotoMessage, normalizeMtprotoUser, privateChatIdOf } from './normalizer.js';

const log = childLogger('userbot-events');

export interface UserbotEventContext {
  client: TelegramClient;
  connectionId: string;
  owner: { id: bigint; sender: NormalizedSender };
  business: Pick<BusinessHandlers, 'handleIncoming' | 'handleEdit' | 'handleDeletedIds'>;
  transport: {
    wasSentByUs(chatId: bigint, messageId: number): boolean;
    waitForInflight(chatId: bigint): Promise<void>;
  };
}

/** Runs a handler without ever letting an error reach GramJS' update loop. Never logs content. */
function guarded(event: string, fn: () => Promise<void>): void {
  fn().catch((error: unknown) => log.error({ error: describeError(error), event }, 'userbot event handler failed'));
}

async function entityOf(load: () => Promise<unknown>): Promise<Api.User | null> {
  try {
    const entity = await load();
    return entity instanceof Api.User ? entity : null;
  } catch (error) {
    log.debug({ error: describeError(error) }, 'could not resolve the chat user');
    return null;
  }
}

function forwardNameOf(m: Api.Message): string | undefined {
  try {
    const fwd = m.forward;
    const entity: unknown = fwd?.sender ?? fwd?.chat;
    if (entity instanceof Api.User) return [entity.firstName, entity.lastName].filter(Boolean).join(' ') || undefined;
    if (entity instanceof Api.Channel || entity instanceof Api.Chat) return entity.title;
  } catch {
    // entities are optional
  }
  return undefined;
}

/**
 * Private chats with real users only: no groups/channels, no Saved Messages, no Telegram
 * service account (777000), no bots. Outgoing messages get the owner as sender.
 */
export async function toNormalized(ctx: UserbotEventContext, m: Api.Message): Promise<NormalizedMessage | null> {
  if (!(m instanceof Api.Message)) return null; // service messages (joins, calls, pins…)
  const chatId = privateChatIdOf(m);
  if (chatId === null || chatId === ctx.owner.id || chatId === TELEGRAM_SERVICE_USER_ID) return null;
  const outgoing = m.out === true;
  const peerUser = await entityOf(() => (outgoing ? m.getChat() : m.getSender()));
  if (peerUser && (peerUser.bot || peerUser.self)) return null;
  // Our own auto reply may still be waiting for its id: let the send finish before classifying.
  if (outgoing) await ctx.transport.waitForInflight(chatId);
  return normalizeMtprotoMessage(m, {
    connectionId: ctx.connectionId,
    owner: ctx.owner.sender,
    peer: peerUser ? normalizeMtprotoUser(peerUser) : null,
    sentByUs: (chat, id) => ctx.transport.wasSentByUs(chat, id),
    forwardName: m.fwdFrom ? forwardNameOf(m) : undefined,
  });
}

/** Subscribes to new/edited/deleted messages. Returns the unsubscribe function. */
export function registerEventHandlers(ctx: UserbotEventContext): () => void {
  const newBuilder = new NewMessage({});
  const editBuilder = new EditedMessage({});
  const deleteBuilder = new DeletedMessage({});

  const onNew = (event: NewMessageEvent) =>
    guarded('new', async () => {
      const msg = await toNormalized(ctx, event.message);
      if (msg) await ctx.business.handleIncoming(msg);
    });

  const onEdit = (event: EditedMessageEvent) =>
    guarded('edit', async () => {
      // Reaction-only updates also arrive as edits; real edits always carry edit_date.
      if (!event.message.editDate) return;
      const msg = await toNormalized(ctx, event.message);
      if (msg) await ctx.business.handleEdit(msg);
    });

  const onDelete = (event: DeletedMessageEvent) =>
    guarded('delete', async () => {
      // Channel deletions carry a peer; private-chat deletions only carry ids (unique per account).
      if (event.peer !== undefined || event.deletedIds.length === 0) return;
      await ctx.business.handleDeletedIds(ctx.connectionId, [...event.deletedIds]);
    });

  ctx.client.addEventHandler(onNew, newBuilder);
  ctx.client.addEventHandler(onEdit, editBuilder);
  ctx.client.addEventHandler(onDelete, deleteBuilder);
  return () => {
    ctx.client.removeEventHandler(onNew, newBuilder);
    ctx.client.removeEventHandler(onEdit, editBuilder);
    ctx.client.removeEventHandler(onDelete, deleteBuilder);
  };
}
