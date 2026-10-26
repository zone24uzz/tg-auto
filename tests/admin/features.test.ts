import { describe, expect, it, vi } from 'vitest';
import type { InlineKeyboard } from 'grammy';
import { buildBusy, buildFeatures, buildWorkHours } from '../../src/telegram/admin/views/features.js';
import { callbackData } from '../../src/telegram/admin/ui.js';
import { ADMIN_ID, baseDeps, callbackUpdate, callsOf, createTestBot, sentTexts, testSettings } from './helpers.js';

function item(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    status: 'PENDING',
    reason: 'PERSONAL',
    detail: null,
    createdAt: new Date(),
    messageId: 900 + id,
    text: 'Ertaga kelasanmi?',
    userLabel: '@ali',
    senderTelegramUserId: 555n,
    uncertainDelivery: false,
    suggestions: ['Ha, kelaman', 'Yo‘q, ertaga bo‘lmaydi'],
    ...over,
  };
}

describe('✨ assistant features screen', () => {
  it('every screen renders with valid buttons', () => {
    const s = testSettings({ busyUntil: new Date(Date.now() + 3_600_000).toISOString(), busyNote: 'uchrashuvda', weekendDays: [6, 0] });
    for (const view of [buildFeatures(s, new Date(), 'Asia/Tashkent'), buildWorkHours(s), buildBusy(s, new Date(), 'Asia/Tashkent')]) {
      expect(view.text.length).toBeGreaterThan(50);
      const data = callbackData(view.keyboard as InlineKeyboard);
      for (const d of data) expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64);
    }
    expect(buildWorkHours(s).text).toContain('Sh, Ya');
    expect(buildBusy(s, new Date(), 'Asia/Tashkent').text).toContain('uchrashuvda');
  });

  it('day-off toggles and quick busy buttons change the settings', async () => {
    const { deps, currentSettings } = baseDeps(testSettings({ weekendDays: [0] }));
    const setBusy = vi.fn(async () => undefined);
    const { bot } = createTestBot({ ...deps, daily: { setBusy, clearBusy: vi.fn(), morningSummaryText: vi.fn(), sendBackup: vi.fn() } });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'fx.wd|6'));
    expect(currentSettings().weekendDays).toEqual([0, 6]);
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'fx.wd|0'));
    expect(currentSettings().weekendDays).toEqual([6]);
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'fx.bs|120'));
    expect(setBusy).toHaveBeenCalledTimes(1);
    const [until] = setBusy.mock.calls[0]! as unknown as [Date];
    expect(Math.abs(until.getTime() - Date.now() - 120 * 60_000)).toBeLessThan(5_000);
  });

  it('a tampered day value is rejected', async () => {
    const { deps, currentSettings } = baseDeps(testSettings({ weekendDays: [0] }));
    const { bot } = createTestBot(deps);
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'fx.wd|9'));
    expect(currentSettings().weekendDays).toEqual([0]);
  });
});

describe('reply drafts and scam warnings in the admin chat', () => {
  it('✉️ 2 sends the second draft through the owner reply path', async () => {
    const { deps } = baseDeps();
    const get = vi.fn(async (id: number) => item(id));
    const ownerManualReply = vi.fn(async () => 'sent' as const);
    const { bot, calls } = createTestBot({ ...deps, attention: { ...deps.attention, get }, pipeline: { ownerManualReply } });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'oa.s|7|1'));
    expect(ownerManualReply).toHaveBeenCalledWith(7, 'Yo‘q, ertaga bo‘lmaydi', ADMIN_ID);
    const answer = callsOf(calls, 'answerCallbackQuery').at(-1)!;
    expect(answer.payload.text).toBe('✅ Yuborildi');
  });

  it('a double tap sends only one draft', async () => {
    const { deps } = baseDeps();
    const get = vi.fn(async (id: number) => item(id));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ownerManualReply = vi.fn(async () => {
      await gate;
      return 'sent' as const;
    });
    const { bot } = createTestBot({ ...deps, attention: { ...deps.attention, get }, pipeline: { ownerManualReply } });
    const first = bot.handleUpdate(callbackUpdate(ADMIN_ID, 'oa.s|7|0'));
    await vi.waitFor(() => expect(ownerManualReply).toHaveBeenCalledTimes(1));
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'oa.s|7|1'));
    release();
    await first;
    expect(ownerManualReply).toHaveBeenCalledTimes(1);
  });

  it('a draft is never sent when an earlier reply may already have been delivered', async () => {
    const { deps } = baseDeps();
    const get = vi.fn(async (id: number) => item(id, { uncertainDelivery: true }));
    const ownerManualReply = vi.fn(async () => 'sent' as const);
    const { bot } = createTestBot({ ...deps, attention: { ...deps.attention, get }, pipeline: { ownerManualReply } });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'oa.s|7|0'));
    expect(ownerManualReply).not.toHaveBeenCalled();
  });

  it('the item view lists the drafts with one-tap buttons', async () => {
    const { deps } = baseDeps();
    const get = vi.fn(async (id: number) => item(id));
    const { bot, calls } = createTestBot({ ...deps, attention: { ...deps.attention, get } });
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'oa.o|7|l'));
    expect(sentTexts(calls)).toContain('Tayyor javoblar');
    const shown = calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').at(-1)!;
    const markup = JSON.stringify(shown.payload.reply_markup);
    expect(markup).toContain('oa.s|7|0|v');
    expect(markup).toContain('oa.s|7|1|v');
  });

  it('🚫 Bloklash on a scam warning blocks the sender; strangers cannot press it', async () => {
    const { deps } = baseDeps();
    const setMode = vi.fn(async () => undefined);
    const { bot } = createTestBot({ ...deps, users: { setMode } });
    await bot.handleUpdate(callbackUpdate(777001, 'sc.b|4242'));
    expect(setMode).not.toHaveBeenCalled();
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'sc.b|4242'));
    expect(setMode).toHaveBeenCalledWith(4242n, 'BLOCK', ADMIN_ID);
  });
});
