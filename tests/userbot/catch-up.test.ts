import type { Api, TelegramClient } from 'telegram';
import { describe, expect, it, vi } from 'vitest';
import type { UserbotEventContext } from '../../src/telegram/userbot/events.js';
import { CATCH_UP_WINDOW_MS, catchUpUnread } from '../../src/telegram/userbot/catch-up.js';
import { CONNECTION_ID, OWNER_ID, PEER_ID, apiUser, ownerSender, privateMessage } from './helpers.js';

function message(id: number, ageMs: number, now: number, extra: { out?: boolean } = {}): Api.Message {
  const m = privateMessage({ id, message: `msg ${id}`, ...extra });
  m.date = Math.floor((now - ageMs) / 1000);
  const peer = apiUser(PEER_ID, { username: 'alice' });
  vi.spyOn(m, 'getSender').mockResolvedValue(peer);
  vi.spyOn(m, 'getChat').mockResolvedValue(peer);
  return m;
}

function setup(dialogs: unknown[], messages: Api.Message[]) {
  const business = {
    handleIncoming: vi.fn(async () => undefined),
    handleEdit: vi.fn(async () => undefined),
    handleDeletedIds: vi.fn(async () => undefined),
  };
  const client = {
    getDialogs: vi.fn(async () => dialogs),
    // GramJS returns newest first.
    getMessages: vi.fn(async () => [...messages].reverse()),
  };
  const ctx: UserbotEventContext = {
    client: client as unknown as TelegramClient,
    connectionId: CONNECTION_ID,
    owner: { id: OWNER_ID, sender: ownerSender },
    business,
    transport: { wasSentByUs: () => false, waitForInflight: async () => undefined },
  };
  return { ctx, business, client };
}

describe('userbot catch-up after reconnect', () => {
  const now = Date.UTC(2026, 9, 4, 12, 0, 0);

  it('feeds recent unread incoming messages (oldest first) into the pipeline', async () => {
    const msgs = [message(10, 20 * 60_000, now), message(11, 5 * 60_000, now)];
    const { ctx, business } = setup([{ isUser: true, unreadCount: 2, entity: apiUser(PEER_ID) }], msgs);
    expect(await catchUpUnread(ctx, now)).toBe(2);
    const ids = business.handleIncoming.mock.calls.map((c) => (c as unknown as [{ telegramMessageId: number }])[0].telegramMessageId);
    expect(ids).toEqual([10, 11]);
  });

  it('skips old messages, our own messages, read chats, groups and bots', async () => {
    const msgs = [message(20, CATCH_UP_WINDOW_MS + 60_000, now), message(21, 60_000, now, { out: true })];
    const { ctx, business, client } = setup(
      [
        { isUser: true, unreadCount: 2, entity: apiUser(PEER_ID) },
        { isUser: true, unreadCount: 0, entity: apiUser(PEER_ID + 1n) },
        { isUser: false, unreadCount: 5, entity: {} },
        { isUser: true, unreadCount: 3, entity: apiUser(PEER_ID + 2n, { bot: true }) },
      ],
      msgs,
    );
    expect(await catchUpUnread(ctx, now)).toBe(0);
    expect(business.handleIncoming).not.toHaveBeenCalled();
    expect(client.getMessages).toHaveBeenCalledTimes(1);
  });

  it('a failing chat does not stop the catch-up of others', async () => {
    const { ctx, business, client } = setup(
      [
        { isUser: true, unreadCount: 1, entity: apiUser(PEER_ID) },
        { isUser: true, unreadCount: 1, entity: apiUser(PEER_ID + 3n) },
      ],
      [message(30, 60_000, now)],
    );
    client.getMessages.mockRejectedValueOnce(new Error('FLOOD_WAIT'));
    expect(await catchUpUnread(ctx, now)).toBe(1);
    expect(business.handleIncoming).toHaveBeenCalledTimes(1);
  });
});
