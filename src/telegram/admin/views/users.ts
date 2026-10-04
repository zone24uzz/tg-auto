import type { Context } from 'grammy';
import type { UserMode } from '../../../generated/prisma/client.js';
import { timeAgo } from '../../../utils/time.js';
import { displayUser, escapeHtml } from '../../common/html.js';
import { cb } from '../callback-data.js';
import { InputError, adminIdOf, ask, type AdminKit } from '../kit.js';
import { Kb, bigId, btn, label, loadPage, pageArg, setNotice, show, type PageInfo, type View } from '../ui.js';
import { MODE_ICON, isUserMode } from './labels.js';

const PER_PAGE = 8;

export interface UserRow {
  telegramUserId: bigint;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  messageCount: number;
  lastMessageAt: Date | null;
  tags: string[];
}

export interface UserItem {
  user: UserRow;
  mode: UserMode | null;
}

function userButton(item: UserItem) {
  const icon = item.mode ? MODE_ICON[item.mode] : '⚪';
  return btn(label(`${icon} ${displayUser(item.user)} · ${item.user.messageCount}`), cb('u', item.user.telegramUserId));
}

export function buildUserList(items: UserItem[], info: PageInfo): View {
  const text = [
    `👤 <b>FOYDALANUVCHILAR</b> (jami ${info.total})`,
    '',
    'Oxirgi xabar bo‘yicha saralangan: rejim · xabarlar soni.',
    '⚪ — alohida qoida yo‘q (umumiy rejim qo‘llanadi).',
    info.total === 0 ? '\n<i>Hali hech kim yozmagan.</i>' : '',
  ].join('\n');
  const kb = new Kb();
  for (const item of items) kb.row(userButton(item));
  kb.row(btn('🔎 Qidirish', 'us.s')).pager(info, (p) => cb('us', p)).back();
  return { text, keyboard: kb.build() };
}

export function buildSearchResults(query: string, items: UserItem[]): View {
  const text = `🔎 «${escapeHtml(label(query, 64))}» bo‘yicha natijalar: <b>${items.length}</b>${items.length === 0 ? '\n\n<i>Hech kim topilmadi.</i>' : ''}`;
  const kb = new Kb();
  for (const item of items) kb.row(userButton(item));
  kb.row(btn('🔎 Yana qidirish', 'us.s')).back(cb('us', 0));
  return { text, keyboard: kb.build() };
}

export function buildUserPage(item: UserItem, now: Date): View {
  const u = item.user;
  const id = u.telegramUserId;
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  const lines = [
    `👤 ${escapeHtml(displayUser(u))}`,
    `Mode: ${item.mode ?? 'DEFAULT'}`,
    `Messages: ${u.messageCount}`,
    `Last message: ${u.lastMessageAt ? timeAgo(u.lastMessageAt, now) : '—'}`,
    '',
    `🆔 <code>${id.toString()}</code>`,
  ];
  if (u.username && name) lines.push(`Ism: ${escapeHtml(name)}`);
  lines.push(`🏷 Teglar: ${u.tags.length ? u.tags.map((t) => `#${escapeHtml(t)}`).join(' ') : '—'}`);
  const mark = (m: UserMode, text: string) => btn(`${item.mode === m ? '✅ ' : ''}${text}`, cb('u.m', id, m));
  const kb = new Kb()
    .row(mark('AUTO', '🤖 Auto'), mark('MANUAL', '👤 Manual'))
    .row(mark('IGNORE', '🚫 Ignore'), mark('BLOCK', '⛔ Block'))
    .row(mark('VIP', '⭐ VIP'), btn('♻️ Reset to default', cb('u.r', id)))
    .row(btn('🏷 Tags', cb('u.t', id)), btn('💬 History', cb('h', 'all', 0, id)))
    .row(btn('🗑 Delete data', cb('pv.du', id)))
    .back(cb('us', 0));
  return { text: lines.join('\n'), keyboard: kb.build() };
}

export function parseTags(text: string): string[] {
  const t = text.trim();
  if (t === '-' || t === '') return [];
  return t.split(/[\s,;]+/).filter(Boolean);
}

export async function showUser(kit: AdminKit, ctx: Context, telegramUserId: bigint): Promise<void> {
  const summary = await kit.deps.users.byTelegramId(telegramUserId);
  if (!summary) {
    await show(ctx, {
      text: `👤 Foydalanuvchi topilmadi (<code>${telegramUserId.toString()}</code>). Ma’lumotlari o‘chirilgan bo‘lishi mumkin.`,
      keyboard: new Kb().back(cb('us', 0)).build(),
    });
    return;
  }
  await show(ctx, buildUserPage(summary, new Date()));
}

export function registerUsers(kit: AdminKit): void {
  const { router, deps } = kit;

  router.action('us', async (ctx, [page]) => {
    const { items, info } = await loadPage(pageArg(page), PER_PAGE, (take, skip) => deps.users.list(take, skip));
    await show(ctx, buildUserList(items, info));
  });

  router.action('us.s', async (ctx) => {
    await ask(kit, ctx, 'us.search', { back: cb('us', 0) }, '🔎 Qidiruv: <b>@username</b>, ism yoki raqamli Telegram ID yuboring.');
  });

  router.input('us.search', async (ctx, text) => {
    const items = await deps.users.search(text.slice(0, 64), 10);
    await show(ctx, buildSearchResults(text, items));
  });

  router.action('u', async (ctx, [raw]) => {
    const id = bigId(raw);
    if (id === null) return { text: 'Bu tugma eskirgan.', alert: true };
    await showUser(kit, ctx, id);
  });

  router.action('u.m', async (ctx, [raw, mode = '']) => {
    const id = bigId(raw);
    if (id === null || !isUserMode(mode)) return { text: 'Bu tugma eskirgan.', alert: true };
    await deps.users.setMode(id, mode, adminIdOf(kit, ctx));
    await showUser(kit, ctx, id);
    return `✅ Mode: ${mode}`;
  });

  router.action('u.r', async (ctx, [raw]) => {
    const id = bigId(raw);
    if (id === null) return { text: 'Bu tugma eskirgan.', alert: true };
    await deps.users.clearMode(id, adminIdOf(kit, ctx));
    await showUser(kit, ctx, id);
    return '♻️ Standart rejimga qaytarildi';
  });

  router.action('u.t', async (ctx, [raw]) => {
    const id = bigId(raw);
    const summary = id === null ? null : await deps.users.byTelegramId(id);
    if (!summary) return { text: 'Foydalanuvchi topilmadi.', alert: true };
    const current = summary.user.tags.length ? summary.user.tags.map((t) => `#${escapeHtml(t)}`).join(' ') : '—';
    await ask(
      kit,
      ctx,
      'u.tags',
      { id: summary.user.telegramUserId.toString(), back: cb('u', summary.user.telegramUserId) },
      `🏷 <b>${escapeHtml(displayUser(summary.user))}</b> uchun teglarni yuboring (vergul yoki bo‘sh joy bilan, maks. 10), masalan: <code>friends, contact</code>.\n\nHozirgi: ${current}\nHammasini olib tashlash: «-»`,
    );
  });

  router.input('u.tags', async (ctx, text, payload) => {
    const id = bigId(String(payload.id ?? ''));
    if (id === null || !(await deps.users.byTelegramId(id))) throw new InputError('Foydalanuvchi topilmadi.');
    const saved = await deps.users.setTags(id, parseTags(text), adminIdOf(kit, ctx));
    setNotice(ctx, `✅ Teglar saqlandi: ${saved.length ? saved.map((t) => `#${escapeHtml(t)}`).join(' ') : '—'}`);
    await showUser(kit, ctx, id);
  });
}
