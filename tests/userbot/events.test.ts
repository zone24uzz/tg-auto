import { Api, type TelegramClient } from 'telegram';
import { DeletedMessage } from 'telegram/events/DeletedMessage.js';
import { NewMessage } from 'telegram/events/index.js';
import { describe, expect, it, vi } from 'vitest';
import { registerEventHandlers, toNormalized, type UserbotEventContext } from '../../src/telegram/userbot/events.js';
import { CONNECTION_ID, OWNER_ID, PEER_ID, apiUser, big, ownerSender, privateMessage } from './helpers.js';

function context(sentIds: number[] = []) {
  const handlers: Array<{ callback: (event: unknown) => void; builder: unknown }> = [];
  const client = {
    addEventHandler: vi.fn((callback: (event: unknown) => void, builder: unknown) => handlers.push({ callback, builder })),
    removeEventHandler: vi.fn(),
  };
  const business = {
    handleIncoming: vi.fn(async () => undefined),
    handleEdit: vi.fn(async () => undefined),
    handleDeletedIds: vi.fn(async () => undefined),
  };
  const transport = {
    wasSentByUs: vi.fn((_chat: bigint, id: number) => sentIds.includes(id)),
    waitForInflight: vi.fn(async () => undefined),
  };
  const ctx: UserbotEventContext = {
    client: client as unknown as TelegramClient,
    connectionId: CONNECTION_ID,
    owner: { id: OWNER_ID, sender: ownerSender },
    business,
    transport,
  };
  return { ctx, client, handlers, business, transport };
}

function withPeer(message: Api.Message, user: Api.User | undefined): Api.Message {
  vi.spyOn(message, 'getSender').mockResolvedValue(user);
  vi.spyOn(message, 'getChat').mockResolvedValue(user);
  return message;
}

describe('userbot events', () => {
  it('uses the resolved peer user (access hash, contact) as sender of incoming messages', async () => {
    const { ctx } = context();
    const user = apiUser(PEER_ID, { username: 'alice', contact: true, accessHash: 55n });
    const msg = await toNormalized(ctx, withPeer(privateMessage({ message: 'hi' }), user));
    expect(msg?.sender).toMatchObject({ telegramUserId: PEER_ID, username: 'alice', accessHash: '55', isContact: true });
  });

  it('skips Saved Messages, the Telegram service account, bots and groups', async () => {
    const { ctx } = context();
    const saved = privateMessage({ peer: new Api.PeerUser({ userId: big(OWNER_ID) }), out: true, message: 'note' });
    expect(await toNormalized(ctx, withPeer(saved, apiUser(OWNER_ID)))).toBeNull();
    const service = privateMessage({ peer: new Api.PeerUser({ userId: big(777000) }), message: 'code 12345' });
    expect(await toNormalized(ctx, withPeer(service, apiUser(777000n)))).toBeNull();
    const fromBot = privateMessage({ message: 'menu' });
    expect(await toNormalized(ctx, withPeer(fromBot, apiUser(PEER_ID, { bot: true })))).toBeNull();
    const group = privateMessage({ peer: new Api.PeerChat({ chatId: big(5) }), message: 'x' });
    expect(await toNormalized(ctx, group)).toBeNull();
  });

  it('treats outgoing messages as the owner’s unless our transport sent them', async () => {
    const { ctx, transport } = context([501]);
    const own = await toNormalized(ctx, withPeer(privateMessage({ id: 500, out: true, message: 'men' }), apiUser(PEER_ID)));
    expect(own).toMatchObject({ sender: ownerSender, sentByBusinessBot: false });
    const auto = await toNormalized(ctx, withPeer(privateMessage({ id: 501, out: true, message: 'auto' }), apiUser(PEER_ID)));
    expect(auto?.sentByBusinessBot).toBe(true);
    expect(transport.waitForInflight).toHaveBeenCalledWith(PEER_ID);
  });

  it('feeds new messages and private deletions to the business handlers', async () => {
    const { ctx, handlers, business, client } = context();
    const unregister = registerEventHandlers(ctx);
    const onNew = handlers.find((h) => h.builder instanceof NewMessage && h.builder.constructor === NewMessage)!;
    const onDelete = handlers.find((h) => h.builder instanceof DeletedMessage)!;

    onNew.callback({ message: withPeer(privateMessage({ message: 'salom' }), apiUser(PEER_ID)) });
    await vi.waitFor(() => expect(business.handleIncoming).toHaveBeenCalledTimes(1));

    onDelete.callback({ deletedIds: [3, 4], peer: undefined });
    onDelete.callback({ deletedIds: [9], peer: new Api.PeerChannel({ channelId: big(1) }) });
    await vi.waitFor(() => expect(business.handleDeletedIds).toHaveBeenCalledTimes(1));
    expect(business.handleDeletedIds).toHaveBeenCalledWith(CONNECTION_ID, [3, 4]);

    unregister();
    expect(client.removeEventHandler).toHaveBeenCalledTimes(3);
  });

  it('never lets a failing handler throw into GramJS', async () => {
    const { ctx, handlers, business } = context();
    business.handleIncoming.mockRejectedValueOnce(new Error('db down'));
    registerEventHandlers(ctx);
    const onNew = handlers.find((h) => h.builder instanceof NewMessage && h.builder.constructor === NewMessage)!;
    expect(() => onNew.callback({ message: withPeer(privateMessage({ message: 'x' }), apiUser(PEER_ID)) })).not.toThrow();
    await vi.waitFor(() => expect(business.handleIncoming).toHaveBeenCalledTimes(1));
  });
});
