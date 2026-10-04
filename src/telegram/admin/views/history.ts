import type { Context } from 'grammy';
import { HISTORY_FILTERS, type HistoryFilter, type HistoryListItem } from '../../../messages/history.service.js';
import { formatDateTime } from '../../../utils/time.js';
import { displayUser, quote } from '../../common/html.js';
import { cb, ROUTES } from '../callback-data.js';
import type { AdminKit } from '../kit.js';
import { Kb, bigId, btn, intId, label, loadPage, pageArg, show, type PageInfo, type View } from '../ui.js';
import { buildMessageDetail, buildMessageVersions } from './message-detail.js';

const PER_PAGE = 10;

export const FILTER_LABELS: Record<HistoryFilter, string> = {
  all: 'All',
  today: 'Today',
  ai: 'AI Answered',
  manual: 'Manual',
  personal: 'Personal',
  edited: 'Edited',
  deleted: 'Deleted',
  media: 'Media',
};

const TITLES: Partial<Record<HistoryFilter, string>> = {
  edited: '✏️ <b>EDITED MESSAGES</b>',
  deleted: '🗑 <b>DELETED MESSAGES</b>',
};

export function isHistoryFilter(v: string): v is HistoryFilter {
  return (HISTORY_FILTERS as readonly string[]).includes(v);
}

export interface HistoryScope {
  filter: HistoryFilter;
  sender: bigint | null;
}

const senderArgs = (scope: HistoryScope): bigint[] => (scope.sender !== null ? [scope.sender] : []);

export function historyCb(scope: HistoryScope, page: number): string {
  return cb('h', scope.filter, page, ...senderArgs(scope));
}

function icons(it: HistoryListItem): string {
  return [
    it.status === 'ANSWERED' ? '🤖' : '',
    it.classification && ['PERSONAL', 'SENSITIVE', 'REQUIRES_OWNER'].includes(it.classification) ? '🔒' : '',
    it.type !== 'TEXT' ? '📎' : '',
    it.edited ? '✏️' : '',
    it.deleted ? '🗑' : '',
  ].join('');
}

export function buildHistoryList(
  items: HistoryListItem[],
  info: PageInfo,
  scope: HistoryScope,
  timezone: string,
  senderLabel?: string,
): View {
  const lines = [
    `${TITLES[scope.filter] ?? '💬 <b>MESSAGE HISTORY</b>'} — ${FILTER_LABELS[scope.filter]} (jami ${info.total})`,
  ];
  if (scope.sender !== null) lines.push(`👤 Foydalanuvchi: ${quote(senderLabel ?? `id ${scope.sender}`, 80)}`);
  lines.push('', '🤖 AI javob berdi · 🔒 shaxsiy · 📎 media · ✏️ tahrirlangan · 🗑 o‘chirilgan');
  if (items.length === 0) lines.push('', '<i>Bu filtr bo‘yicha xabar yo‘q.</i>');
  if (scope.filter === 'deleted') lines.push('', 'ℹ️ O‘chirilganlar faqat bot ulangandan keyin kelgan xabarlar uchun ma’lum.');

  const kb = new Kb().grid(
    HISTORY_FILTERS.map((f) => btn(`${f === scope.filter ? '🔵 ' : ''}${FILTER_LABELS[f]}`, cb('h', f, 0, ...senderArgs(scope)))),
    4,
  );
  for (const it of items) {
    const who = scope.sender !== null ? '' : `${it.userLabel} `;
    kb.row(
      btn(
        label(`${formatDateTime(it.createdAt, timezone)} ${who}${icons(it)} ${it.preview}`, 64),
        cb(ROUTES.messageOpen, it.id, scope.filter, info.page, ...senderArgs(scope)),
      ),
    );
  }
  kb.pager(info, (p) => historyCb(scope, p));
  if (scope.sender !== null) kb.row(btn('👤 Foydalanuvchi sahifasi', cb('u', scope.sender)));
  return { text: lines.join('\n'), keyboard: kb.back().build() };
}

export function registerHistory(kit: AdminKit): void {
  const { router, deps } = kit;

  const showList = async (ctx: Context, scope: HistoryScope, page: number) => {
    const opts = scope.sender !== null ? { senderTelegramUserId: scope.sender } : {};
    const { items, info } = await loadPage(page, PER_PAGE, (take, skip) => deps.history.list(scope.filter, take, skip, opts));
    let senderLabel: string | undefined;
    if (scope.sender !== null) {
      const summary = await deps.users.byTelegramId(scope.sender);
      senderLabel = summary ? displayUser(summary.user) : undefined;
    }
    await show(ctx, buildHistoryList(items, info, scope, deps.timezone, senderLabel));
  };

  router.action('h', async (ctx, [filter = 'all', page, rawSender]) => {
    if (!isHistoryFilter(filter)) return { text: 'Bu tugma eskirgan.', alert: true };
    await showList(ctx, { filter, sender: bigId(rawSender) }, pageArg(page));
  });

  // msg.o|<id>                       — from a notification: opens as a new message
  // msg.o|<id>|<filter>|<page>[|uid] — from the history list
  // msg.o|<id>|oa|<attentionId>      — from an owner-attention item
  router.action(ROUTES.messageOpen, async (ctx, [rawId, a, b, c]) => {
    const id = intId(rawId);
    const detail = id === null ? null : await deps.history.detail(id);
    if (!detail) return { text: 'Xabar topilmadi (o‘chirilgan yoki saqlash muddati tugagan bo‘lishi mumkin).', alert: true };
    let back: string = cb('h', 'all', 0);
    let fresh = false;
    if (a === 'oa' && intId(b) !== null) back = cb(ROUTES.attentionOpen, b ?? '', 'l');
    else if (a && isHistoryFilter(a)) back = historyCb({ filter: a, sender: bigId(c) }, pageArg(b));
    else fresh = true;
    await show(ctx, buildMessageDetail(detail, back, deps.timezone), { fresh });
  });

  // msg.v|<id>|<page> — every stored version of one message
  router.action('msg.v', async (ctx, [rawId, page]) => {
    const id = intId(rawId);
    const detail = id === null ? null : await deps.history.detail(id);
    if (!detail) return { text: 'Xabar topilmadi (o‘chirilgan yoki saqlash muddati tugagan bo‘lishi mumkin).', alert: true };
    await show(ctx, buildMessageVersions(detail, pageArg(page), deps.timezone));
  });
}
