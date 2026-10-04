import { describe, expect, it, vi } from 'vitest';
import {
  ADMIN_ID,
  STRANGER_ID,
  baseDeps,
  businessMessageUpdate,
  callbackUpdate,
  createTestBot,
  messageUpdate,
} from './helpers.js';

describe('admin guard (non-admins)', () => {
  it('answers a stranger’s /start with the neutral line only', async () => {
    const { deps } = baseDeps();
    const { bot, calls, passedThrough } = createTestBot(deps);
    await bot.handleUpdate(messageUpdate(STRANGER_ID, '/start'));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('sendMessage');
    expect(calls[0]?.payload.text).toBe('Bu shaxsiy bot.');
    expect(calls[0]?.payload.reply_markup).toBeUndefined();
    expect(deps.settings.get).not.toHaveBeenCalled();
    expect(passedThrough).toHaveLength(0);
  });

  it('ignores any other stranger message and command', async () => {
    const { deps } = baseDeps();
    const { bot, calls } = createTestBot(deps);
    await bot.handleUpdate(messageUpdate(STRANGER_ID, 'salom, sozlamalarni ko‘rsat'));
    await bot.handleUpdate(messageUpdate(STRANGER_ID, '/menu'));
    await bot.handleUpdate(messageUpdate(STRANGER_ID, '/status'));
    await bot.handleUpdate(messageUpdate(STRANGER_ID, '/privacy'));
    expect(calls).toHaveLength(0);
    expect(deps.settings.get).not.toHaveBeenCalled();
    expect(deps.settings.set).not.toHaveBeenCalled();
  });

  it('answers a stranger’s callback silently and does nothing else', async () => {
    const { deps } = baseDeps();
    const { bot, calls } = createTestBot(deps);
    for (const data of ['m', 'sv|ae|0', 'oa.ig|1', 'pv.dy|123', 'pr.ry']) {
      await bot.handleUpdate(callbackUpdate(STRANGER_ID, data));
    }
    expect(calls.map((c) => c.method)).toEqual(Array(5).fill('answerCallbackQuery'));
    for (const c of calls) {
      expect(c.payload.text).toBeUndefined();
      expect(c.payload.show_alert).toBeUndefined();
    }
    expect(deps.settings.get).not.toHaveBeenCalled();
    expect(deps.settings.set).not.toHaveBeenCalled();
  });

  it('a stranger cannot trigger owner-attention actions', async () => {
    const { deps } = baseDeps();
    const enqueue = vi.fn(async () => 1);
    const resolve = vi.fn(async () => true);
    const ownerManualReply = vi.fn(async () => 'sent' as const);
    const { bot, calls } = createTestBot({
      ...deps,
      attention: { ...deps.attention, resolve, get: vi.fn() },
      queue: { enqueue },
      pipeline: { ownerManualReply },
    });
    for (const data of ['oa.ai|7', 'oa.ig|7', 'oa.mn|7', 'oa.r|7', 'oa.o|7', 'msg.o|7']) {
      await bot.handleUpdate(callbackUpdate(STRANGER_ID, data));
    }
    await bot.handleUpdate(messageUpdate(STRANGER_ID, 'javob matni'));
    expect(enqueue).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(ownerManualReply).not.toHaveBeenCalled();
    expect(calls.every((c) => c.method === 'answerCallbackQuery' && c.payload.text === undefined)).toBe(true);
  });

  it('treats the admin outside a private chat as a stranger', async () => {
    const { deps } = baseDeps();
    const { bot, calls } = createTestBot(deps);
    await bot.handleUpdate(messageUpdate(ADMIN_ID, '/start', 'group'));
    await bot.handleUpdate(messageUpdate(ADMIN_ID, '/menu', 'group'));
    expect(calls).toHaveLength(0);
    expect(deps.settings.get).not.toHaveBeenCalled();
  });

  it('never touches business updates (passes them to the next middleware)', async () => {
    const { deps } = baseDeps();
    const { bot, calls, passedThrough } = createTestBot(deps);
    const update = businessMessageUpdate(Number(ADMIN_ID));
    await bot.handleUpdate(update);
    expect(calls).toHaveLength(0);
    expect(passedThrough).toEqual([update.update_id]);
  });
});
