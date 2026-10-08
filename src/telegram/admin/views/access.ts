import type { Context } from 'grammy';
import type { Tenant } from '../../../generated/prisma/client.js';
import { AI_LABEL, type AiChoice } from '../../../onboarding/texts.js';
import { isReadyForApproval, type AccessGroup } from '../../../tenancy/access.service.js';
import { formatDateTime } from '../../../utils/time.js';
import { escapeHtml } from '../../common/html.js';
import { cb } from '../callback-data.js';
import type { AdminKit } from '../kit.js';
import { Kb, btn, loadPage, pageArg, setNotice, show, type View } from '../ui.js';

const PER_PAGE = 8;
const GROUP_CODE: Record<AccessGroup, string> = { pending: 'p', active: 'a', rejected: 'r' };
const CODE_GROUP: Record<string, AccessGroup> = { p: 'pending', a: 'active', r: 'rejected' };
export const GROUP_TITLE: Record<AccessGroup, string> = {
  pending: '⏳ Access kutayotganlar',
  active: '✅ Access berilganlar',
  rejected: '🚫 Access berilmaganlar',
};

/** The three Access buttons of the super-admin's main menu. */
export function accessMenuButtons(counts: Record<AccessGroup, number>) {
  return [
    btn(`⏳ Kutmoqda (${counts.pending})`, cb('acc.l', GROUP_CODE.pending, 0)),
    btn(`✅ Ruxsat (${counts.active})`, cb('acc.l', GROUP_CODE.active, 0)),
    btn(`🚫 Rad (${counts.rejected})`, cb('acc.l', GROUP_CODE.rejected, 0)),
  ];
}

function label(t: Tenant): string {
  const name = [t.firstName, t.username ? `@${t.username}` : null].filter(Boolean).join(' ');
  return name || `id ${t.telegramUserId}`;
}

/** Only the super-admin (ADMIN_TELEGRAM_USER_ID) manages access. */
export function isSuperAdmin(kit: AdminKit, ctx: Context): boolean {
  return ctx.from !== undefined && BigInt(ctx.from.id) === kit.deps.adminTelegramUserId && ctx.chat?.type === 'private';
}

function renderDetail(t: Tenant, timezone: string): View {
  const status =
    t.status === 'ACTIVE' ? '✅ Ruxsat berilgan' : t.status === 'PENDING' ? (t.onboardingStep ? '🛠 Sozlamoqda' : '⏳ Kutmoqda') : '🚫 Rad etilgan';
  const lines = [
    `👤 <b>${escapeHtml(label(t))}</b>`,
    `ID: <code>${t.telegramUserId}</code>`,
    `Holat: ${status}`,
    `Til: ${t.language} · AI: ${t.aiProvider ? AI_LABEL[t.aiProvider as AiChoice] : '—'}${t.aiApiKey ? ' (kalit bor)' : ''}`,
    `So‘rov: ${formatDateTime(t.createdAt, timezone)}${t.approvedAt ? ` · Ruxsat: ${formatDateTime(t.approvedAt, timezone)}` : ''}`,
  ];
  const kb = new Kb();
  if (isReadyForApproval(t)) kb.row(btn('✅ Ruxsat berish', cb('acc.ok', t.id)));
  else if (t.status === 'PENDING') lines.push('', '<i>Foydalanuvchi hali sozlashni tugatmagan — tasdiqlash so‘rov yuborilgandan keyin.</i>');
  if (t.status === 'PENDING') kb.row(btn('🚫 Rad etish', cb('acc.no', t.id)));
  if (t.status === 'ACTIVE') kb.row(btn('🚫 Ruxsatni olib qo‘yish', cb('acc.no', t.id)));
  if (t.status === 'REJECTED' || t.status === 'SUSPENDED') kb.row(btn('🔄 Qaytadan so‘rov berishga ruxsat', cb('acc.re', t.id)));
  const group: AccessGroup = t.status === 'ACTIVE' ? 'active' : t.status === 'PENDING' ? 'pending' : 'rejected';
  kb.back(cb('acc.l', GROUP_CODE[group], 0));
  return { text: lines.join('\n'), keyboard: kb.build() };
}

export function registerAccess(kit: AdminKit): void {
  const { router, deps } = kit;
  const denied = { text: '⛔ Faqat bosh administrator uchun.', alert: true };

  const showList = async (ctx: Context, group: AccessGroup, page: number) => {
    const access = deps.access!;
    const { items, info } = await loadPage(page, PER_PAGE, (take, skip) => access.list(group, take, skip));
    const lines = [`<b>${GROUP_TITLE[group]}</b> — ${info.total} ta`, ''];
    if (items.length === 0) lines.push('Hozircha hech kim yo‘q.');
    const kb = new Kb();
    for (const t of items) kb.row(btn(label(t).slice(0, 48), cb('acc.v', t.id)));
    if (info.pages > 1)
      kb.row(
        info.page > 0 ? btn('◀️', cb('acc.l', GROUP_CODE[group], info.page - 1)) : null,
        btn(`${info.page + 1}/${info.pages}`, 'nop'),
        info.page + 1 < info.pages ? btn('▶️', cb('acc.l', GROUP_CODE[group], info.page + 1)) : null,
      );
    kb.back();
    await show(ctx, { text: lines.join('\n'), keyboard: kb.build() });
  };

  router.action('acc.l', async (ctx, [code, page]) => {
    if (!deps.access || !isSuperAdmin(kit, ctx)) return denied;
    await showList(ctx, CODE_GROUP[code ?? ''] ?? 'pending', pageArg(page));
  });

  router.action('acc.v', async (ctx, [id]) => {
    if (!deps.access || !isSuperAdmin(kit, ctx)) return denied;
    const t = await deps.access.get(Number(id));
    if (!t) return 'Topilmadi';
    await show(ctx, renderDetail(t, deps.timezone));
  });

  router.action('acc.ok', async (ctx, [id]) => {
    if (!deps.access || !isSuperAdmin(kit, ctx)) return denied;
    const result = await deps.access.approve(Number(id));
    const t = await deps.access.get(Number(id));
    if (result === 'full') return { text: '⚠️ Joy qolmagan: MAX_TENANTS chegarasiga yetildi (Render free’da har bir userbot RAM oladi).', alert: true };
    if (result === 'incomplete') return { text: '⚠️ Bu so‘rov tayyor emas: foydalanuvchi sozlashni tugatmagan yoki tasdiqlangan API kaliti yo‘q.', alert: true };
    if (result === 'not_found' || !t) return 'Topilmadi';
    setNotice(ctx, result === 'approved' ? `✅ ${escapeHtml(label(t))} ga ruxsat berildi.` : 'ℹ️ Allaqachon ruxsat berilgan.');
    await show(ctx, renderDetail(t, deps.timezone));
  });

  router.action('acc.re', async (ctx, [id]) => {
    if (!deps.access || !isSuperAdmin(kit, ctx)) return denied;
    const ok = await deps.access.reopen(Number(id));
    const t = await deps.access.get(Number(id));
    if (!ok || !t) return 'Bajarib bo‘lmadi';
    setNotice(ctx, `🔄 ${escapeHtml(label(t))}: qaytadan so‘rov berishi mumkin (xabar yuborildi).`);
    await show(ctx, renderDetail(t, deps.timezone));
  });

  router.action('acc.no', async (ctx, [id]) => {
    if (!deps.access || !isSuperAdmin(kit, ctx)) return denied;
    const ok = await deps.access.reject(Number(id));
    const t = await deps.access.get(Number(id));
    if (!ok || !t) return 'Bajarib bo‘lmadi';
    setNotice(ctx, `🚫 ${escapeHtml(label(t))}: ruxsat berilmadi.`);
    await show(ctx, renderDetail(t, deps.timezone));
  });
}
