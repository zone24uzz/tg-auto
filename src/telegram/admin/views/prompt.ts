import type { Context } from 'grammy';
import { MAX_PROMPT_LENGTH } from '../../../conversations/prompt.service.js';
import { formatDateTime } from '../../../utils/time.js';
import { cb } from '../callback-data.js';
import { adminIdOf, ask, type AdminKit } from '../kit.js';
import { Kb, btn, fit, loadPage, pageArg, setNotice, show, type PageInfo, type View } from '../ui.js';

const PER_PAGE = 6;
/** Leaves room for the header inside Telegram's 4096-char message limit. */
const VIEW_CHARS = 3500;

export function buildPromptMenu(active: { version: number; content: string }): View {
  const text = [
    '📝 <b>SYSTEM PROMPT</b>',
    '',
    `Faol versiya: <b>v${active.version}</b> (${active.content.length} / ${MAX_PROMPT_LENGTH} belgi)`,
    '',
    'Bu — <b>egasining ko‘rsatmalari</b> qismi: AI kim nomidan, qanday ohangda va nimalar haqida javob berishini shu yerda yozasiz.',
    '🛡 Asosiy xavfsizlik qoidalari (ko‘rsatmalar va sozlamalarni oshkor qilmaslik, prompt-injection himoyasi, shaxsiy hayotingiz haqida to‘qimaslik, so‘ralganda AI ekanini tan olish va h.k.) alohida qatlamda turadi — ularni bu prompt orqali bekor qilib bo‘lmaydi.',
  ].join('\n');
  const kb = new Kb()
    .row(btn('👁 Ko‘rish', 'pr.v'), btn('✏️ Tahrirlash', 'pr.e'))
    .row(btn('🕘 Versiyalar', cb('pr.l', 0)), btn('🔄 Standartga qaytarish', 'pr.r'))
    .back();
  return { text, keyboard: kb.build() };
}

export function buildPromptView(p: { version: number; content: string }, isActive: boolean, createdAt?: Date, timezone?: string): View {
  const meta = createdAt && timezone ? ` · ${formatDateTime(createdAt, timezone)}` : '';
  const text = [
    `📝 <b>v${p.version}</b>${isActive ? ' (faol)' : ''}${meta} · ${p.content.length} belgi`,
    '',
    `<pre>${fit(p.content, VIEW_CHARS)}</pre>`,
  ].join('\n');
  const kb = new Kb();
  if (isActive) kb.row(btn('✏️ Tahrirlash', 'pr.e')).back('pr');
  else kb.row(btn('♻️ Restore', cb('pr.rs', p.version))).back(cb('pr.l', 0));
  return { text, keyboard: kb.build() };
}

export interface PromptVersionRow {
  version: number;
  content: string;
  isActive: boolean;
  createdAt: Date;
}

export function buildPromptVersions(items: PromptVersionRow[], info: PageInfo, timezone: string): View {
  const text = `🕘 <b>PROMPT VERSIYALARI</b> (jami ${info.total})\n\nKo‘rish va tiklash uchun versiyani tanlang. Tiklash yangi versiya sifatida saqlanadi.`;
  const kb = new Kb();
  for (const v of items) {
    kb.row(btn(`${v.isActive ? '✅ ' : ''}v${v.version} · ${formatDateTime(v.createdAt, timezone)} · ${v.content.length} belgi`, cb('pr.s', v.version)));
  }
  kb.pager(info, (p) => cb('pr.l', p)).back('pr');
  return { text, keyboard: kb.build() };
}

export function buildResetConfirm(): View {
  return {
    text: '🔄 <b>Standart promptga qaytarilsinmi?</b>\n\nJoriy prompt o‘rniga standart matn yangi versiya sifatida saqlanadi. Eski versiyalar 🕘 Versiyalar bo‘limida qoladi.',
    keyboard: new Kb().row(btn('✅ Ha, qaytarish', 'pr.ry'), btn('❌ Yo‘q', 'pr')).build(),
  };
}

function versionArg(raw: string | undefined): number | null {
  return raw && /^\d{1,6}$/.test(raw) ? Number(raw) : null;
}

export function registerPrompt(kit: AdminKit): void {
  const { router, deps } = kit;

  const showMenu = async (ctx: Context) => {
    await show(ctx, buildPromptMenu(await deps.prompts.getActive()));
  };

  router.action('pr', async (ctx) => {
    await showMenu(ctx);
  });

  router.action('pr.v', async (ctx) => {
    await show(ctx, buildPromptView(await deps.prompts.getActive(), true));
  });

  router.action('pr.e', async (ctx) => {
    const active = await deps.prompts.getActive();
    await ask(
      kit,
      ctx,
      'pr.edit',
      { back: 'pr' },
      [
        '✏️ <b>Yangi prompt matnini yuboring.</b>',
        '',
        `Keyingi xabaringiz yangi versiya (v${active.version + 1}) bo‘lib saqlanadi va darhol faollashadi.`,
        `Uzunlik: 10–${MAX_PROMPT_LENGTH} belgi (Telegram bitta xabarda 4096 belgigacha ruxsat beradi).`,
        'Joriy matnni 👁 Ko‘rish orqali nusxalab, tahrirlab yuborishingiz mumkin.',
      ].join('\n'),
    );
  });

  router.input('pr.edit', async (ctx, text) => {
    const version = await deps.prompts.update(text, adminIdOf(kit, ctx));
    setNotice(ctx, `✅ Prompt saqlandi: <b>v${version}</b>`);
    await showMenu(ctx);
  });

  router.action('pr.l', async (ctx, [page]) => {
    const { items, info } = await loadPage(pageArg(page), PER_PAGE, (take, skip) => deps.prompts.list(take, skip));
    await show(ctx, buildPromptVersions(items, info, deps.timezone));
  });

  router.action('pr.s', async (ctx, [raw]) => {
    const version = versionArg(raw);
    const row = version === null ? null : await deps.prompts.getVersion(version);
    if (!row) return { text: 'Bunday versiya topilmadi.', alert: true };
    await show(ctx, buildPromptView(row, row.isActive, row.createdAt, deps.timezone));
  });

  router.action('pr.rs', async (ctx, [raw]) => {
    const version = versionArg(raw);
    if (version === null) return { text: 'Bu tugma eskirgan.', alert: true };
    const newVersion = await deps.prompts.restore(version, adminIdOf(kit, ctx));
    setNotice(ctx, `♻️ v${version} tiklandi → yangi faol versiya <b>v${newVersion}</b>`);
    await showMenu(ctx);
    return '♻️ Tiklandi';
  });

  router.action('pr.r', async (ctx) => {
    await show(ctx, buildResetConfirm());
  });

  router.action('pr.ry', async (ctx) => {
    const newVersion = await deps.prompts.resetDefault(adminIdOf(kit, ctx));
    setNotice(ctx, `🔄 Standart prompt tiklandi: <b>v${newVersion}</b>`);
    await showMenu(ctx);
    return '🔄 Standartga qaytarildi';
  });
}
