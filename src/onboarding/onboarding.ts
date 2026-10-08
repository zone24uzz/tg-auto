import { existsSync } from 'node:fs';
import path from 'node:path';
import { InlineKeyboard, InputFile, type Api, type Context } from 'grammy';
import type { Db } from '../database/client.js';
import type { Tenant } from '../generated/prisma/client.js';
import { childLogger } from '../logging/logger.js';
import { describeError } from '../logging/sanitize.js';
import type { ContentCipher } from '../security/crypto.js';
import { escapeHtml } from '../telegram/common/html.js';
import { LANGS, type Lang } from '../tenancy/context.js';
import { langOf, type TenantService } from '../tenancy/tenant.service.js';
import { checkApiKey, cleanKey, type KeyCheck, type KeyCheckEnv } from './key-check.js';
import { AI_CHOICES, AI_LABEL, LANG_BUTTONS, T, type AiChoice } from './texts.js';

const log = childLogger('onboarding');

/** Callback prefix of onboarding buttons (`ob|<verb>|<arg>`). */
export const ONBOARDING_ROUTE = 'ob';
/** Super-admin access routes (handled by the admin UI, see views/access.ts). */
export const ACCESS_ROUTES = { approve: 'acc.ok', reject: 'acc.no', view: 'acc.v' } as const;
/** Unfinished setups kept at most (protects the database from /start floods); they expire after a day. */
const MAX_OPEN_REQUESTS = 200;
export const OPEN_SETUP_TTL_MS = 24 * 3_600_000;
/** API key checks per person per window (each one is an outbound request of up to 15 s). */
const KEY_CHECKS_PER_WINDOW = 5;
const KEY_CHECK_WINDOW_MS = 10 * 60_000;
const LOGO = path.resolve('assets', 'logo.jpg');

type Step = 'lang' | 'ai' | 'key' | 'consent';

export interface OnboardingDeps {
  db: Db;
  api: Pick<Api, 'sendMessage'>;
  tenants: TenantService;
  cipher: ContentCipher;
  superAdminId: bigint;
  keyEnv: KeyCheckEnv;
  /** Injected in tests. */
  checkKey?: (ai: AiChoice, key: string) => Promise<KeyCheck>;
}

/**
 * First contact for anyone without an active workspace: /start → language → AI provider → API key
 * (checked live) → how it works + consent → request sent to the super-admin, who approves it in the
 * Access menu. Progress lives in `tenants.onboardingStep`, so restarts never lose it.
 */
export class Onboarding {
  private readonly keyChecks = new Map<bigint, number[]>();

  constructor(private readonly d: OnboardingDeps) {}

  /** Sliding-window limit on key checks per person. */
  private allowKeyCheck(userId: bigint): boolean {
    const now = Date.now();
    const recent = (this.keyChecks.get(userId) ?? []).filter((t) => now - t < KEY_CHECK_WINDOW_MS);
    if (recent.length >= KEY_CHECKS_PER_WINDOW) {
      this.keyChecks.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.keyChecks.set(userId, recent);
    if (this.keyChecks.size > 10_000) this.keyChecks.clear();
    return true;
  }

  /** Deletes setups abandoned before submitting (scheduler, system scope). Returns how many. */
  async expireAbandoned(now = new Date()): Promise<number> {
    const r = await this.d.db.tenant.deleteMany({
      where: { status: 'PENDING', onboardingStep: { not: null }, updatedAt: { lt: new Date(now.getTime() - OPEN_SETUP_TTL_MS) } },
    });
    if (r.count > 0) this.d.tenants.invalidate();
    return r.count;
  }

  /** Handles a private-chat update of a user without an active workspace. */
  async handle(ctx: Context): Promise<void> {
    const from = ctx.from;
    if (!from || from.is_bot || ctx.chat?.type !== 'private') return;
    // API keys and account sessions must never be stored in plaintext: no sign-up without encryption.
    if (!this.d.cipher.enabled) {
      await ctx.answerCallbackQuery().catch(() => undefined);
      if (ctx.message) await ctx.reply(T[langOf((from.language_code ?? '').slice(0, 2))].unavailable).catch(() => undefined);
      return;
    }
    try {
      if (ctx.callbackQuery) await this.onCallback(ctx, BigInt(from.id));
      else if (ctx.message) await this.onMessage(ctx, BigInt(from.id));
    } catch (error) {
      log.error({ error: describeError(error) }, 'onboarding step failed');
      await ctx.answerCallbackQuery().catch(() => undefined);
    }
  }

  // ── messages ───────────────────────────────────────────────────────────

  private async onMessage(ctx: Context, userId: bigint): Promise<void> {
    const tenant = await this.d.db.tenant.findUnique({ where: { telegramUserId: userId } });
    if (!tenant) {
      await this.begin(ctx, userId);
      return;
    }
    const t = T[langOf(tenant.language)];
    if (tenant.status === 'REJECTED') return void (await ctx.reply(t.rejected));
    if (tenant.status === 'SUSPENDED') return void (await ctx.reply(t.suspended));
    if (tenant.status !== 'PENDING') return;
    const step = tenant.onboardingStep as Step | null;
    if (step === null) return void (await ctx.reply(t.pending, { reply_markup: new InlineKeyboard().text(t.restart, `${ONBOARDING_ROUTE}|restart`) }));
    if (step === 'key') return this.onKey(ctx, tenant);
    await this.showStep(ctx, tenant, step);
  }

  private async begin(ctx: Context, userId: bigint): Promise<void> {
    const open = await this.d.db.tenant.count({ where: { status: 'PENDING', onboardingStep: { not: null } } });
    const guess = langOf((ctx.from?.language_code ?? '').slice(0, 2));
    if (open >= MAX_OPEN_REQUESTS) {
      await ctx.reply(T[guess].full);
      return;
    }
    const tenant = await this.d.db.tenant.upsert({
      where: { telegramUserId: userId },
      create: {
        telegramUserId: userId,
        username: ctx.from?.username ?? null,
        firstName: ctx.from?.first_name?.slice(0, 64) ?? null,
        language: guess,
        status: 'PENDING',
        onboardingStep: 'lang',
      },
      update: {},
    });
    this.d.tenants.invalidate();
    const t = T[langOf(tenant.language)];
    if (existsSync(LOGO)) {
      await ctx.replyWithPhoto(new InputFile(LOGO), { caption: t.welcome, parse_mode: 'HTML' }).catch(async () => ctx.reply(t.welcome, { parse_mode: 'HTML' }));
    } else {
      await ctx.reply(t.welcome, { parse_mode: 'HTML' });
    }
    await this.showStep(ctx, tenant, 'lang');
  }

  private async onKey(ctx: Context, tenant: Tenant): Promise<void> {
    const lang = langOf(tenant.language);
    const t = T[lang];
    const ai = (tenant.aiProvider ?? 'gemini') as AiChoice;
    const text = ctx.message?.text;
    if (!text || text.startsWith('/')) {
      await ctx.reply(text?.startsWith('/') ? t.sendKey(ai) : t.sendText, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: this.keyKb(lang) });
      return;
    }
    // The key must not stay in the chat history.
    await ctx.deleteMessage().catch(() => undefined);
    if (!this.allowKeyCheck(tenant.telegramUserId)) return void (await ctx.reply(t.tooMany));
    const key = cleanKey(text);
    const progress = await ctx.reply(t.checking);
    const verdict = await (this.d.checkKey ? this.d.checkKey(ai, key) : checkApiKey(ai, key, this.d.keyEnv));
    await ctx.api.deleteMessage(progress.chat.id, progress.message_id).catch(() => undefined);
    if (verdict === 'invalid') return void (await ctx.reply(t.keyInvalid, { reply_markup: this.keyKb(lang) }));
    if (verdict === 'unavailable') return void (await ctx.reply(t.keyCheckFailed, { reply_markup: this.keyKb(lang) }));

    const updated = await this.d.db.tenant.update({
      where: { id: tenant.id },
      data: { aiApiKey: this.d.cipher.encrypt(key), onboardingStep: 'consent' },
    });
    await ctx.reply(t.keyOk(ai));
    await this.showStep(ctx, updated, 'consent');
  }

  // ── buttons ────────────────────────────────────────────────────────────

  private async onCallback(ctx: Context, userId: bigint): Promise<void> {
    const [route, verb, arg] = (ctx.callbackQuery?.data ?? '').split('|');
    await ctx.answerCallbackQuery().catch(() => undefined);
    if (route !== ONBOARDING_ROUTE) return;
    const tenant = await this.d.db.tenant.findUnique({ where: { telegramUserId: userId } });
    if (!tenant || tenant.status !== 'PENDING') return;
    const lang = langOf(tenant.language);

    switch (verb) {
      case 'lang': {
        if (!(LANGS as readonly string[]).includes(arg ?? '')) return;
        const updated = await this.setStep(tenant, 'ai', { language: arg as Lang });
        await this.edit(ctx, updated, 'ai');
        return;
      }
      case 'ai': {
        if (!(AI_CHOICES as readonly string[]).includes(arg ?? '')) return;
        const updated = await this.setStep(tenant, 'key', { aiProvider: arg as AiChoice, aiApiKey: null });
        await this.edit(ctx, updated, 'key');
        return;
      }
      case 'back': {
        const updated = await this.setStep(tenant, 'ai', { aiApiKey: null });
        await this.edit(ctx, updated, 'ai');
        return;
      }
      case 'agree': {
        if (tenant.onboardingStep !== 'consent' || !tenant.aiApiKey) return;
        const updated = await this.d.db.tenant.update({ where: { id: tenant.id }, data: { onboardingStep: null, consentAt: new Date() } });
        this.d.tenants.invalidate();
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        await ctx.reply(T[lang].submitted);
        await this.notifySuperAdmin(updated);
        return;
      }
      case 'restart': {
        const updated = await this.setStep(tenant, 'lang', { aiApiKey: null, consentAt: null });
        await this.edit(ctx, updated, 'lang');
        return;
      }
      case 'cancel': {
        await this.d.db.tenant.delete({ where: { id: tenant.id } });
        this.d.tenants.invalidate();
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        await ctx.reply(T[lang].cancelled);
        return;
      }
      default:
        return;
    }
  }

  // ── rendering ──────────────────────────────────────────────────────────

  private async setStep(tenant: Tenant, step: Step, data: Partial<Pick<Tenant, 'language' | 'aiProvider' | 'aiApiKey' | 'consentAt'>> = {}): Promise<Tenant> {
    const updated = await this.d.db.tenant.update({ where: { id: tenant.id }, data: { ...data, onboardingStep: step } });
    this.d.tenants.invalidate();
    return updated;
  }

  private keyKb(lang: Lang): InlineKeyboard {
    return new InlineKeyboard().text(T[lang].back, `${ONBOARDING_ROUTE}|back`).text(T[lang].cancel, `${ONBOARDING_ROUTE}|cancel`);
  }

  private view(tenant: Tenant, step: Step): { text: string; kb: InlineKeyboard } {
    const lang = langOf(tenant.language);
    const t = T[lang];
    const cancel = `${ONBOARDING_ROUTE}|cancel`;
    if (step === 'lang') {
      const kb = new InlineKeyboard();
      for (const b of LANG_BUTTONS) kb.text(b.label, `${ONBOARDING_ROUTE}|lang|${b.lang}`);
      return { text: t.chooseLang, kb };
    }
    if (step === 'ai') {
      const kb = new InlineKeyboard();
      for (const ai of AI_CHOICES) kb.text(AI_LABEL[ai], `${ONBOARDING_ROUTE}|ai|${ai}`).row();
      kb.text(t.cancel, cancel);
      return { text: t.chooseAi, kb };
    }
    if (step === 'key') return { text: t.sendKey((tenant.aiProvider ?? 'gemini') as AiChoice), kb: this.keyKb(lang) };
    return {
      text: t.consent,
      kb: new InlineKeyboard().text(t.agree, `${ONBOARDING_ROUTE}|agree`).row().text(t.restart, `${ONBOARDING_ROUTE}|restart`).text(t.cancel, cancel),
    };
  }

  private async showStep(ctx: Context, tenant: Tenant, step: Step): Promise<void> {
    const v = this.view(tenant, step);
    await ctx.reply(v.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: v.kb });
  }

  /** Replaces the pressed message with the next step (falls back to a new message). */
  private async edit(ctx: Context, tenant: Tenant, step: Step): Promise<void> {
    const v = this.view(tenant, step);
    try {
      await ctx.editMessageText(v.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: v.kb });
    } catch {
      await this.showStep(ctx, tenant, step);
    }
  }

  private async notifySuperAdmin(tenant: Tenant): Promise<void> {
    const who = [tenant.firstName ? escapeHtml(tenant.firstName) : null, tenant.username ? `@${escapeHtml(tenant.username)}` : null]
      .filter(Boolean)
      .join(' ');
    const text = [
      '🆕 <b>Yangi foydalanuvchi ruxsat so‘ramoqda</b>',
      '',
      `👤 ${who || '—'} (id <code>${tenant.telegramUserId}</code>)`,
      `🌐 Til: ${tenant.language} · 🤖 AI: ${tenant.aiProvider ? AI_LABEL[tenant.aiProvider as AiChoice] : '—'} (kalit tekshirildi ✅)`,
    ].join('\n');
    const kb = new InlineKeyboard()
      .text('✅ Ruxsat berish', `${ACCESS_ROUTES.approve}|${tenant.id}`)
      .text('🚫 Rad etish', `${ACCESS_ROUTES.reject}|${tenant.id}`);
    try {
      await this.d.api.sendMessage(Number(this.d.superAdminId), text, { parse_mode: 'HTML', reply_markup: kb });
    } catch (error) {
      log.warn({ error: describeError(error) }, 'could not notify the super-admin about a new request');
    }
  }
}
