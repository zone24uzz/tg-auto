import type { Context } from 'grammy';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../src/audit/audit.service.js';
import type { KeyCheck } from '../../src/onboarding/key-check.js';
import { Onboarding } from '../../src/onboarding/onboarding.js';
import { ContentCipher } from '../../src/security/crypto.js';
import { buildDefaultSettings } from '../../src/settings/schema.js';
import { SettingsService } from '../../src/settings/settings.service.js';
import { AccessService } from '../../src/tenancy/access.service.js';
import { TenantService } from '../../src/tenancy/tenant.service.js';
import { testEnv } from '../support/env.js';
import { createTestDb, hasDb, type TestDb } from './helpers.js';

const d = hasDb ? describe : describe.skip;
const SUPER = 900n;
const USER = 4242;
const KEY = `AIza${'k'.repeat(35)}`;

interface Sent {
  method: string;
  text?: string;
  data?: string[];
}

/** A minimal grammY context for a private chat with USER. */
function fakeCtx(sent: Sent[], update: { text?: string; data?: string; photo?: boolean }): Context {
  const keyboardData = (extra: unknown): string[] => {
    const markup = (extra as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } } | undefined)?.reply_markup;
    return (markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? '');
  };
  const reply = vi.fn(async (text: string, extra?: unknown) => {
    sent.push({ method: 'reply', text, data: keyboardData(extra) });
    return { message_id: sent.length, chat: { id: USER } };
  });
  return {
    from: { id: USER, is_bot: false, first_name: 'Aziz', username: 'aziz_dev', language_code: 'ru' },
    chat: { id: USER, type: 'private' },
    message: update.data ? undefined : { text: update.text, photo: update.photo ? [{}] : undefined, message_id: 77 },
    callbackQuery: update.data ? { data: update.data } : undefined,
    reply,
    replyWithPhoto: vi.fn(async (_p: unknown, extra?: { caption?: string }) => {
      sent.push({ method: 'photo', text: extra?.caption });
      return { message_id: 1, chat: { id: USER } };
    }),
    editMessageText: vi.fn(async (text: string, extra?: unknown) => {
      sent.push({ method: 'edit', text, data: keyboardData(extra) });
      return true;
    }),
    editMessageReplyMarkup: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => {
      sent.push({ method: 'delete' });
      return true;
    }),
    answerCallbackQuery: vi.fn(async () => true),
    api: { deleteMessage: vi.fn(async () => true) },
  } as unknown as Context;
}

d('onboarding + access (real PostgreSQL)', () => {
  let tdb: TestDb;
  let tenants: TenantService;
  let onboarding: Onboarding;
  let access: AccessService;
  let settings: SettingsService;
  let sent: Sent[];
  let adminMessages: Array<{ chatId: number; text: string; data: string[] }>;
  let verdict: KeyCheck;
  const cipher = new ContentCipher(Buffer.alloc(32, 7).toString('base64'));

  const say = (u: { text?: string; data?: string; photo?: boolean }) => onboarding.handle(fakeCtx(sent, u));
  const tenant = () => tdb.db.tenant.findUnique({ where: { telegramUserId: BigInt(USER) } });

  beforeEach(async () => {
    if (tdb) await tdb.drop();
    tdb = await createTestDb();
    tenants = new TenantService(tdb.db);
    await tenants.ensureSuperAdmin(SUPER);
    sent = [];
    adminMessages = [];
    verdict = 'valid';
    const api = {
      sendMessage: vi.fn(async (chatId: number, text: string, extra?: { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } }) => {
        adminMessages.push({ chatId, text, data: (extra?.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? '') });
        return { message_id: 1 };
      }),
    };
    onboarding = new Onboarding({
      db: tdb.db,
      api: api as never,
      tenants,
      cipher,
      superAdminId: SUPER,
      keyEnv: { GEMINI_BASE_URL: '', OPENAI_BASE_URL: '', ANTHROPIC_BASE_URL: '' },
      checkKey: async () => verdict,
    });
    settings = new SettingsService(tdb.db, buildDefaultSettings(testEnv()), new AuditService(tdb.db));
    access = new AccessService({ db: tdb.db, api: api as never, tenants, settings, superAdminId: SUPER, maxTenants: 1 });
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('full flow: /start → language → AI → key → consent → request → approval', async () => {
    await say({ text: '/start' });
    expect(sent.some((s) => s.method === 'photo' || s.text?.includes('Здравствуйте'))).toBe(true); // language guessed from the client (ru)
    expect(sent.at(-1)!.data).toEqual(['ob|lang|uz', 'ob|lang|ru', 'ob|lang|en']);
    expect(await tenant()).toMatchObject({ status: 'PENDING', onboardingStep: 'lang', username: 'aziz_dev' });

    await say({ data: 'ob|lang|uz' });
    expect(sent.at(-1)!.data).toEqual(['ob|ai|gemini', 'ob|ai|openai', 'ob|ai|anthropic', 'ob|cancel']);
    await say({ data: 'ob|ai|gemini' });
    expect(await tenant()).toMatchObject({ language: 'uz', aiProvider: 'gemini', onboardingStep: 'key' });

    // A wrong key: error, still waiting for a key; the message with the key is deleted.
    verdict = 'invalid';
    await say({ text: 'not-a-key' });
    expect(sent.some((s) => s.method === 'delete')).toBe(true);
    expect(sent.at(-1)!.text).toContain('Bu API kalit noto‘g‘ri');
    expect((await tenant())!.aiApiKey).toBeNull();

    verdict = 'valid';
    await say({ text: `  ${KEY} ` });
    const afterKey = (await tenant())!;
    expect(afterKey.onboardingStep).toBe('consent');
    expect(afterKey.aiApiKey).toMatch(/^enc:v1:/);
    expect(cipher.decrypt(afterKey.aiApiKey)).toBe(KEY);
    expect(sent.at(-1)!.data).toContain('ob|agree');

    await say({ data: 'ob|agree' });
    expect(await tenant()).toMatchObject({ status: 'PENDING', onboardingStep: null });
    expect(sent.at(-1)!.text).toContain('So‘rovingiz yuborildi');
    const request = adminMessages.find((m) => m.chatId === Number(SUPER))!;
    expect(request.text).toContain('Yangi foydalanuvchi');
    expect(request.data).toEqual([`acc.ok|${afterKey.id}`, `acc.no|${afterKey.id}`]);
    expect(await access.counts()).toEqual({ pending: 1, active: 1, rejected: 0 });

    // While waiting, any message gets the "pending" answer.
    await say({ text: 'salom' });
    expect(sent.at(-1)!.text).toContain('ko‘rib chiqilmoqda');

    expect(await access.approve(afterKey.id)).toBe('approved');
    const approved = (await tenant())!;
    expect(approved.status).toBe('ACTIVE');
    // The new workspace gets its own AI and its owner's own name.
    await tenants.run(approved, async () => {
      const s = await settings.get();
      expect(s).toMatchObject({ aiProvider: 'gemini', aiModel: 'gemini-3.8-flash', ownerName: 'Aziz' });
      // Contact-facing texts carry the new owner's name, never the super-admin's.
      for (const text of [s.personalReplyText, s.ownerRequiredReplyText, s.fallbackReplyText]) {
        expect(text).toContain('Aziz');
        expect(text).not.toContain(testEnv().OWNER_DISPLAY_NAME);
      }
    });
    expect(adminMessages.at(-1)!.chatId).toBe(USER);
    expect(adminMessages.at(-1)!.text).toContain('Ruxsat berildi');
    expect(await access.approve(afterKey.id)).toBe('already');
  });

  it('rejection wipes the stored key; the user is told; cancel removes the request', async () => {
    await say({ text: '/start' });
    await say({ data: 'ob|lang|en' });
    await say({ data: 'ob|ai|gemini' });
    await say({ text: KEY });
    await say({ data: 'ob|agree' });
    const t = (await tenant())!;
    expect(await access.reject(t.id)).toBe(true);
    expect(await tenant()).toMatchObject({ status: 'REJECTED', aiApiKey: null });
    expect(adminMessages.at(-1)).toMatchObject({ chatId: USER });
    expect(adminMessages.at(-1)!.text).toContain('declined');
    await say({ text: '/start' });
    expect(sent.at(-1)!.text).toContain('declined');
    // The super-admin's own workspace can never be rejected.
    const superTenant = (await tenants.byTelegramUserId(SUPER))!;
    expect(await access.reject(superTenant.id)).toBe(false);
  });

  it('cancel during setup deletes the request', async () => {
    await say({ text: '/start' });
    await say({ data: 'ob|cancel' });
    expect(await tenant()).toBeNull();
  });

  it('approval respects MAX_TENANTS (the super-admin does not count)', async () => {
    const ready = { status: 'PENDING' as const, aiProvider: 'gemini', aiApiKey: cipher.encrypt(KEY), onboardingStep: null };
    const a = await tdb.db.tenant.create({ data: { telegramUserId: 1n, firstName: 'A', ...ready } });
    const b = await tdb.db.tenant.create({ data: { telegramUserId: 2n, firstName: 'B', ...ready } });
    expect(await access.approve(a.id)).toBe('approved');
    expect(await access.approve(b.id)).toBe('full');
  });

  it('a stale approve button cannot activate a workspace without a finished setup and a verified key', async () => {
    const midSetup = await tdb.db.tenant.create({ data: { telegramUserId: 11n, status: 'PENDING', onboardingStep: 'key', aiProvider: 'gemini' } });
    expect(await access.approve(midSetup.id)).toBe('incomplete');
    const noKey = await tdb.db.tenant.create({ data: { telegramUserId: 12n, status: 'REJECTED', aiProvider: 'gemini' } });
    expect(await access.approve(noKey.id)).toBe('incomplete');
    expect((await tdb.db.tenant.findUniqueOrThrow({ where: { id: noKey.id } })).status).toBe('REJECTED');
  });

  it('reopen lets a declined person set up again and tells them', async () => {
    const declined = await tdb.db.tenant.create({ data: { telegramUserId: BigInt(USER), status: 'REJECTED', language: 'en' } });
    expect(await access.reopen(declined.id)).toBe(true);
    expect(await tenant()).toMatchObject({ status: 'PENDING', onboardingStep: 'lang', aiApiKey: null });
    expect(adminMessages.at(-1)!.text).toContain('apply again');
    await say({ text: '/start' });
    expect(sent.at(-1)!.data).toEqual(['ob|lang|uz', 'ob|lang|ru', 'ob|lang|en']);
  });

  it('limits API key checks per person', async () => {
    await say({ text: '/start' });
    await say({ data: 'ob|lang|uz' });
    await say({ data: 'ob|ai|gemini' });
    verdict = 'invalid';
    for (let i = 0; i < 5; i++) await say({ text: `bad-${i}` });
    await say({ text: 'bad-6' });
    expect(sent.at(-1)!.text).toContain('Juda ko‘p urinish');
  });

  it('expires setups abandoned before submitting, keeps submitted requests', async () => {
    const old = new Date(Date.now() - 48 * 3_600_000);
    await tdb.db.tenant.create({ data: { telegramUserId: 21n, status: 'PENDING', onboardingStep: 'ai', updatedAt: old } });
    await tdb.db.tenant.create({ data: { telegramUserId: 22n, status: 'PENDING', onboardingStep: null, aiApiKey: 'enc:v1:x', updatedAt: old } });
    expect(await onboarding.expireAbandoned()).toBe(1);
    expect(await tdb.db.tenant.findUnique({ where: { telegramUserId: 22n } })).not.toBeNull();
  });

  it('a photo while a key is expected asks for text', async () => {
    await say({ text: '/start' });
    await say({ data: 'ob|lang|uz' });
    await say({ data: 'ob|ai|openai' });
    await say({ photo: true });
    expect(sent.at(-1)!.text).toContain('matn ko‘rinishida');
  });
});
