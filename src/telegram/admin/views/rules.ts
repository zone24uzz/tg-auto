import type { Context } from 'grammy';
import type { UserMode } from '../../../generated/prisma/client.js';
import { REPLY_MODES, type Settings } from '../../../settings/schema.js';
import { escapeHtml } from '../../common/html.js';
import { cb } from '../callback-data.js';
import { choiceBtn, toggleBtn } from '../controls.js';
import { adminIdOf, ask, type AdminKit } from '../kit.js';
import { Kb, btn, intId, loadPage, pageArg, setNotice, show, type PageInfo, type View } from '../ui.js';
import { MODE_ICON, USER_MODES, isUserMode } from './labels.js';

type ReplyMode = (typeof REPLY_MODES)[number];

export const REPLY_MODE_INFO: Record<ReplyMode, { label: string; desc: string }> = {
  ALL_ALLOWED: { label: 'Hammaga', desc: 'bloklangan va e’tiborsizlardan tashqari hammaga AI javob beradi.' },
  NEW_CHATS_ONLY: { label: 'Faqat yangi chatlar', desc: 'siz hali yozmagan (yangi) chatlarga javob beriladi.' },
  NON_CONTACTS_ONLY: { label: 'Kontakt bo‘lmaganlar', desc: '«contact» tegi qo‘yilmagan foydalanuvchilarga javob beriladi.' },
  ALLOWLIST_ONLY: { label: 'Faqat allowlist', desc: 'faqat ⭐ Allowlist dagilarga javob beriladi, qolganlari qo‘lda.' },
  CUSTOM: { label: 'Custom', desc: 'qoidalar ishlaydi, qoidasizlar uchun pastdagi rejim qo‘llanadi.' },
};

const UNKNOWN_MODES = ['AUTO', 'MANUAL', 'IGNORE'] as const;
const TAG_PER_PAGE = 8;

export function buildReplyRules(s: Settings): View {
  const lines = ['👥 <b>JAVOB QOIDALARI</b>', '', `Rejim: <b>${REPLY_MODE_INFO[s.replyMode].label}</b> (${s.replyMode})`, ''];
  for (const m of REPLY_MODES) lines.push(`${m === s.replyMode ? '🔵' : '⚪'} <b>${REPLY_MODE_INFO[m].label}</b> — ${REPLY_MODE_INFO[m].desc}`);
  lines.push(
    '',
    `Qoidasiz foydalanuvchilar (Custom): <b>${s.unknownUserMode}</b>`,
    '',
    'ℹ️ Telegram botlarga kontaktlaringiz ro‘yxatini bermaydi, shuning uchun «Kontakt bo‘lmaganlar» rejimi «contact» tegi qo‘yilgan foydalanuvchilarni kontakt deb hisoblaydi. Telegram → Sozlamalar → Telegram Business → Chatbotlar bo‘limida ham bot kimlarga javob berishini cheklash mumkin.',
    '',
    '⛔ Block, 🔕 Ignore, ⭐ VIP va 👤 Manual qoidalari har qanday rejimda ustun turadi.',
  );
  const kb = new Kb();
  for (const m of REPLY_MODES) kb.row(choiceBtn('rm', m, s.replyMode === m, REPLY_MODE_INFO[m].label));
  kb.row(...UNKNOWN_MODES.map((m) => choiceBtn('um', m, s.unknownUserMode === m, m)))
    .row(toggleBtn('nm', s.notifyManualMessages, 'Manual xabarlar 🔔'), toggleBtn('nv', s.notifyVipMessages, 'VIP xabarlar 🔔'))
    .row(btn('🏷 Teg qoidalari', cb('rr.t', 0)))
    .back();
  return { text: lines.join('\n'), keyboard: kb.build() };
}

export interface TagRule {
  id: number;
  matchValue: string;
  mode: UserMode;
}

export function buildTagRules(items: TagRule[], info: PageInfo): View {
  const lines = [
    '🏷 <b>TEG QOIDALARI</b>',
    '',
    'Foydalanuvchilarga teg qo‘ying (👤 Users → 🏷 Tags) va teg uchun rejim belgilang, masalan: <code>friends → MANUAL</code>.',
    'Aniq foydalanuvchi qoidasi tegdan ustun; bir nechta teg mos kelsa, eng qat’iysi tanlanadi.',
    '',
  ];
  if (items.length === 0) lines.push('<i>Hozircha teg qoidalari yo‘q.</i>');
  for (const r of items) lines.push(`• #${escapeHtml(r.matchValue)} → ${MODE_ICON[r.mode]} ${r.mode}`);
  const kb = new Kb();
  for (const r of items) kb.row(btn(`❌ #${r.matchValue} → ${r.mode}`, cb('rr.tx', r.id, info.page)));
  kb.row(btn('➕ Teg qoidasi qo‘shish', 'rr.ta')).pager(info, (p) => cb('rr.t', p)).back('rr');
  return { text: lines.join('\n'), keyboard: kb.build() };
}

export function buildTagModePicker(): View {
  const kb = new Kb().grid(
    USER_MODES.map((m) => btn(`${MODE_ICON[m]} ${m}`, cb('rr.tm', m))),
    3,
  );
  return { text: '🏷 Yangi teg qoidasi uchun rejimni tanlang:', keyboard: kb.back(cb('rr.t', 0)).build() };
}

export function registerRules(kit: AdminKit): void {
  const { router, deps } = kit;

  router.action('rr', async (ctx) => {
    await show(ctx, buildReplyRules(await deps.settings.get()));
  });

  const showTags = async (ctx: Context, page: number) => {
    const where = { matchType: 'TAG' as const };
    const { items, info } = await loadPage(page, TAG_PER_PAGE, async (take, skip) => {
      const [rows, total] = await Promise.all([
        deps.db.userRule.findMany({ where, orderBy: { matchValue: 'asc' }, take, skip }),
        deps.db.userRule.count({ where }),
      ]);
      return { items: rows, total };
    });
    await show(ctx, buildTagRules(items, info));
  };

  router.action('rr.t', async (ctx, [page]) => {
    await showTags(ctx, pageArg(page));
  });

  router.action('rr.tx', async (ctx, [rawId, page]) => {
    const id = intId(rawId);
    const rule = id ? await deps.db.userRule.findUnique({ where: { id } }) : null;
    if (rule && rule.matchType === 'TAG') await deps.rules.removeRule('TAG', rule.matchValue, adminIdOf(kit, ctx));
    await showTags(ctx, pageArg(page));
    return rule ? '🗑 O‘chirildi' : 'Allaqachon o‘chirilgan';
  });

  router.action('rr.ta', async (ctx) => {
    await show(ctx, buildTagModePicker());
  });

  router.action('rr.tm', async (ctx, [mode = '']) => {
    if (!isUserMode(mode)) return { text: 'Bu tugma eskirgan.', alert: true };
    await ask(
      kit,
      ctx,
      'rr.tag',
      { mode, back: cb('rr.t', 0) },
      `🏷 Teg nomini yuboring (masalan: <code>friends</code>). Rejim: <b>${MODE_ICON[mode]} ${mode}</b>`,
    );
  });

  router.input('rr.tag', async (ctx, text, payload) => {
    const mode = String(payload.mode ?? '');
    if (!isUserMode(mode)) return;
    await deps.rules.setRule('TAG', text, mode, adminIdOf(kit, ctx));
    setNotice(ctx, '✅ Teg qoidasi saqlandi.');
    await showTags(ctx, 0);
  });
}
