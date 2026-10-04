import type { Context } from 'grammy';
import type { RuleMatchType, UserMode } from '../../../generated/prisma/client.js';
import { displayUser, escapeHtml } from '../../common/html.js';
import { cb } from '../callback-data.js';
import { InputError, adminIdOf, ask, type AdminKit } from '../kit.js';
import { Kb, btn, intId, label, loadPage, pageArg, setNotice, show, type PageInfo, type View } from '../ui.js';

const PER_PAGE = 8;

export const LISTS = {
  a: {
    mode: 'AUTO',
    title: '⭐ ALLOWLIST',
    desc: 'Bu ro‘yxatdagilarga AI har doim javob beradi. «Faqat allowlist» rejimida — faqat ularga.',
  },
  b: {
    mode: 'BLOCK',
    title: '🚫 BLOCKLIST',
    desc: 'Bu ro‘yxatdagilarga hech qachon javob berilmaydi; xabarlar faqat tarix uchun saqlanadi.',
  },
  i: {
    mode: 'IGNORE',
    title: '🔕 IGNORE LIST',
    desc: 'Bu ro‘yxatdagilarga javob berilmaydi va ular haqida bildirishnoma yuborilmaydi.',
  },
} as const satisfies Record<string, { mode: UserMode; title: string; desc: string }>;

export type ListCode = keyof typeof LISTS;

export function isListCode(v: string): v is ListCode {
  return v in LISTS;
}

export interface ListRule {
  id: number;
  matchType: RuleMatchType;
  matchValue: string;
}

/** Human label for a rule; `names` maps numeric user id → display name. */
export function ruleLabel(rule: Pick<ListRule, 'matchType' | 'matchValue'>, names: ReadonlyMap<string, string> = new Map()): string {
  switch (rule.matchType) {
    case 'USER_ID': {
      const name = names.get(rule.matchValue);
      return name ? `${name} (${rule.matchValue})` : `id ${rule.matchValue}`;
    }
    case 'USERNAME':
      return `@${rule.matchValue}`;
    case 'TAG':
      return `#${rule.matchValue}`;
    case 'CHAT_ID':
    default:
      return `chat ${rule.matchValue}`;
  }
}

export function buildList(code: ListCode, items: ListRule[], info: PageInfo, names: ReadonlyMap<string, string>): View {
  const list = LISTS[code];
  const lines = [`<b>${list.title}</b> (jami ${info.total})`, '', list.desc, ''];
  if (items.length === 0) lines.push('<i>Ro‘yxat bo‘sh.</i>');
  for (const r of items) lines.push(`• ${escapeHtml(ruleLabel(r, names))}`);
  const kb = new Kb();
  for (const r of items) kb.row(btn(label(`❌ ${ruleLabel(r, names)}`), cb('ls.x', r.id, code, info.page)));
  kb.row(btn('➕ Qo‘shish', cb('ls.a', code))).pager(info, (p) => cb('ls', code, p)).back();
  return { text: lines.join('\n'), keyboard: kb.build() };
}

/** "123456" → USER_ID, "#tag" → TAG, anything else → USERNAME (validated by the rules service). */
export function parseRuleTarget(text: string): { matchType: RuleMatchType; value: string } {
  const t = text.trim();
  if (/^-?\d{1,20}$/.test(t)) return { matchType: 'USER_ID', value: t };
  if (t.startsWith('#')) return { matchType: 'TAG', value: t };
  return { matchType: 'USERNAME', value: t };
}

export function registerLists(kit: AdminKit): void {
  const { router, deps } = kit;

  const showList = async (ctx: Context, code: ListCode, page: number) => {
    const { items, info } = await loadPage(page, PER_PAGE, (take, skip) => deps.rules.list(LISTS[code].mode, take, skip));
    const ids = items
      .filter((r) => r.matchType === 'USER_ID' && /^-?\d{1,20}$/.test(r.matchValue))
      .map((r) => BigInt(r.matchValue));
    const users = ids.length ? await deps.db.telegramUser.findMany({ where: { telegramUserId: { in: ids } } }) : [];
    const names = new Map(users.map((u) => [u.telegramUserId.toString(), displayUser(u)]));
    await show(ctx, buildList(code, items, info, names));
  };

  router.action('ls', async (ctx, [code = '', page]) => {
    if (!isListCode(code)) return { text: 'Bu tugma eskirgan.', alert: true };
    await showList(ctx, code, pageArg(page));
  });

  router.action('ls.x', async (ctx, [rawId, code = '', page]) => {
    if (!isListCode(code)) return { text: 'Bu tugma eskirgan.', alert: true };
    const id = intId(rawId);
    const rule = id ? await deps.db.userRule.findUnique({ where: { id } }) : null;
    const removed = !!rule && rule.mode === LISTS[code].mode;
    if (rule && removed) await deps.rules.removeRule(rule.matchType, rule.matchValue, adminIdOf(kit, ctx));
    await showList(ctx, code, pageArg(page));
    return removed ? '🗑 Ro‘yxatdan olib tashlandi' : 'Allaqachon olib tashlangan';
  });

  router.action('ls.a', async (ctx, [code = '']) => {
    if (!isListCode(code)) return { text: 'Bu tugma eskirgan.', alert: true };
    await ask(
      kit,
      ctx,
      'ls.add',
      { m: code, back: cb('ls', code, 0) },
      `➕ <b>${LISTS[code].title}</b> ga qo‘shish:\nraqamli Telegram ID (masalan <code>123456789</code>), <code>@username</code> yoki <code>#teg</code> yuboring.`,
    );
  });

  router.input('ls.add', async (ctx, text, payload) => {
    const code = String(payload.m ?? '');
    if (!isListCode(code)) throw new InputError('Bu so‘rov eskirgan.');
    const target = parseRuleTarget(text);
    await deps.rules.setRule(target.matchType, target.value, LISTS[code].mode, adminIdOf(kit, ctx));
    setNotice(ctx, '✅ Qo‘shildi.');
    await showList(ctx, code, 0);
  });
}
