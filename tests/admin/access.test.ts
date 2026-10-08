import { describe, expect, it, vi } from 'vitest';
import { ADMIN_ID, baseDeps, callbackUpdate, callsOf, createTestBot, messageUpdate, sentTexts } from './helpers.js';

const STRANGER = 555_001;

function setup() {
  const { deps } = baseDeps();
  const onboarding = { handle: vi.fn(async () => undefined) };
  const tenant = { id: 7, telegramUserId: 31337n, firstName: 'Aziz', username: 'aziz', status: 'PENDING', onboardingStep: null, language: 'ru', aiProvider: 'gemini', aiApiKey: 'enc:v1:x', createdAt: new Date(0), approvedAt: null };
  const access = {
    counts: vi.fn(async () => ({ pending: 2, active: 1, rejected: 0 })),
    list: vi.fn(async () => ({ items: [tenant], total: 1 })),
    get: vi.fn(async () => tenant),
    approve: vi.fn(async () => {
      tenant.status = 'ACTIVE';
      return 'approved' as const;
    }),
    reject: vi.fn(async () => true),
  };
  Object.assign(deps, { onboarding, access });
  return { deps, onboarding, access, ...createTestBot(deps) };
}

describe('strangers and access management', () => {
  it('a stranger’s /start goes to onboarding instead of “Bu shaxsiy bot.”', async () => {
    const { bot, calls, onboarding } = setup();
    await bot.handleUpdate(messageUpdate(STRANGER, '/start'));
    expect(onboarding.handle).toHaveBeenCalledTimes(1);
    expect(sentTexts(calls)).not.toContain('Bu shaxsiy bot');
    // Their button presses go there too (never into the admin UI).
    await bot.handleUpdate(callbackUpdate(STRANGER, 'ar'));
    expect(onboarding.handle).toHaveBeenCalledTimes(2);
  });

  it('the super-admin’s main menu shows the three Access buttons with counts', async () => {
    const { bot, calls } = setup();
    await bot.handleUpdate(messageUpdate(ADMIN_ID, '/menu'));
    const markup = JSON.stringify(callsOf(calls, 'sendMessage').at(-1)!.payload.reply_markup);
    expect(markup).toContain('Kutmoqda (2)');
    expect(markup).toContain('Ruxsat (1)');
    expect(markup).toContain('Rad (0)');
  });

  it('lists pending requests and approves from the detail screen', async () => {
    const { bot, calls, access } = setup();
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'acc.l|p|0'));
    expect(access.list).toHaveBeenCalledWith('pending', expect.any(Number), 0);
    expect(sentTexts(calls)).toContain('Access kutayotganlar');
    await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'acc.ok|7'));
    expect(access.approve).toHaveBeenCalledWith(7);
    expect(sentTexts(calls)).toContain('ruxsat berildi');
  });

  it('only the super-admin can use Access routes', async () => {
    const { bot, calls, access } = setup();
    await bot.handleUpdate(callbackUpdate(STRANGER, 'acc.ok|7'));
    expect(access.approve).not.toHaveBeenCalled();
    expect(callsOf(calls, 'editMessageText')).toHaveLength(0);
  });
});
