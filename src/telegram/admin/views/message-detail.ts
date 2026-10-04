import type { MessageDetail } from '../../../messages/history.service.js';
import { formatDateTime } from '../../../utils/time.js';
import { displayUser, escapeHtml } from '../../common/html.js';
import { cb, ROUTES } from '../callback-data.js';
import { reasonLabel } from '../notifier.js';
import { Kb, btn, fit, num, paginate, usd, type View } from '../ui.js';
import { attentionStatusLabel } from './labels.js';

interface Limits {
  text: number;
  version: number;
  response: number;
  media: number;
  /** Short untrusted fields: reasons, file names, errors, provider/model names. */
  meta: number;
  maxVersions: number;
  maxItems: number;
}

/** Progressively tighter budgets so the whole detail always fits one Telegram message. */
const BUDGETS: Limits[] = [
  { text: 900, version: 300, response: 500, media: 250, meta: 150, maxVersions: 10, maxItems: 6 },
  { text: 500, version: 150, response: 250, media: 120, meta: 100, maxVersions: 6, maxItems: 5 },
  { text: 250, version: 80, response: 120, media: 60, meta: 60, maxVersions: 4, maxItems: 4 },
  { text: 100, version: 40, response: 50, media: 30, meta: 30, maxVersions: 3, maxItems: 3 },
  { text: 60, version: 20, response: 30, media: 20, meta: 20, maxVersions: 2, maxItems: 1 },
];
const MAX_HTML = 3900;

const PERSONAL = new Set(['PERSONAL', 'SENSITIVE', 'REQUIRES_OWNER']);

function body(v: { text: string | null; caption: string | null } | undefined): string | null {
  if (!v) return null;
  return [v.text, v.caption].filter(Boolean).join('\n') || null;
}

function render(m: MessageDetail, tz: string, l: Limits): string {
  const lines: string[] = [`💬 <b>MESSAGE #${m.id}</b>`, ''];
  const s = m.sender;
  lines.push(s ? `👤 Kimdan: ${fit(displayUser(s), Math.min(80, l.meta * 2))} (<code>${s.telegramUserId.toString()}</code>)` : '👤 Kimdan: —');
  lines.push(`🕐 Yozilgan: ${formatDateTime(m.telegramDate, tz)}`);
  lines.push(`📄 Turi: ${m.type} · Holat: ${m.status}${m.statusReason ? ` (${fit(m.statusReason, l.meta)})` : ''}`);
  if (m.classification) {
    const conf = m.classificationConfidence !== null ? ` (${Math.round(m.classificationConfidence * 100)}%)` : '';
    const icon = PERSONAL.has(m.classification) ? '🔒' : '🏷';
    lines.push(`${icon} Tasnif: ${m.classification}${conf}${m.classificationReason ? ` — <i>${fit(m.classificationReason, l.meta)}</i>` : ''}`);
  } else {
    lines.push('🏷 Tasnif: —');
  }
  if (m.injectionSuspected) lines.push('⚠️ Prompt-injection urinishi shubhasi bor');

  const versions = m.versions;
  const original = versions[0];
  const latest = versions[versions.length - 1];
  lines.push('', '<b>📝 Asl xabar (v1):</b>', `<blockquote>${fit(body(original), l.text)}</blockquote>`);
  if (versions.length > 1 && latest) {
    lines.push(`<b>✏️ Hozirgi matn (v${latest.version}):</b>`, `<blockquote>${fit(body(latest), l.text)}</blockquote>`);
    lines.push(`<b>🕘 Tahrirlar tarixi (${versions.length} versiya):</b>`);
    const shown = versions.length > l.maxVersions ? [...versions.slice(0, 1), ...versions.slice(-(l.maxVersions - 1))] : versions;
    for (const v of shown) {
      lines.push(`${v.version}. ${formatDateTime(v.editedAt ?? v.createdAt, tz)} — ${fit(body(v), l.version)}`);
    }
    if (shown.length < versions.length) lines.push(`<i>… yana ${versions.length - shown.length} ta versiya</i>`);
  }
  if (m.editedAt) lines.push(`✏️ Oxirgi tahrir: ${formatDateTime(m.editedAt, tz)}`);
  lines.push(m.deletedAt ? `🗑 <b>O‘chirilgan:</b> ${formatDateTime(m.deletedAt, tz)}` : '🗑 O‘chirilmagan');

  if (m.media.length) {
    lines.push('', '<b>📎 Media:</b>');
    for (const x of m.media.slice(0, l.maxItems)) {
      lines.push(`• ${escapeHtml(x.kind)} — ${escapeHtml(x.status)}${x.fileName ? ` · ${fit(x.fileName, l.meta)}` : ''}`);
      if (x.description) lines.push(`  🖼 ${fit(x.description, l.media)}`);
      if (x.extractedText) lines.push(`  📄 ${fit(x.extractedText, l.media)}`);
      if (x.error) lines.push(`  ⚠️ ${fit(x.error, l.meta)}`);
    }
  }

  if (m.responses.length) {
    lines.push('', `<b>🤖 AI javoblar (${m.responses.length}):</b>`);
    for (const r of m.responses.slice(-l.maxItems)) {
      const latency = r.latencyMs !== null ? `${(r.latencyMs / 1000).toFixed(1)} s` : '—';
      lines.push(
        `• ${escapeHtml(r.kind)} · ${escapeHtml(r.status)} · ${formatDateTime(r.createdAt, tz)}`,
        `  🧠 ${fit(r.provider ?? '—', 30)} / ${fit(r.model ?? '—', Math.min(60, l.meta * 2))} · reasoning: ${fit(r.reasoningEffort ?? '—', 20)}`,
        `  🔢 ${num(r.inputTokens)} → ${num(r.outputTokens)} · 💸 ${usd(r.costUsd)} · ⏱ ${latency} · fallback: ${r.usedFallback ? 'ha' : 'yo‘q'}`,
      );
      if (r.text) lines.push(`  <blockquote>${fit(r.text, l.response)}</blockquote>`);
    }
  } else {
    lines.push('', '🤖 AI javob yo‘q');
  }

  lines.push(
    '',
    m.attention
      ? `🔔 Owner attention: #${m.attention.id} · ${attentionStatusLabel(m.attention.status)} · ${fit(reasonLabel(m.attention.reason), 80)}`
      : '🔔 Owner attention: —',
  );
  return lines.join('\n');
}

function renderMinimal(m: MessageDetail, tz: string): string {
  return [
    `💬 <b>MESSAGE #${m.id}</b>`,
    '',
    `👤 Kimdan: ${m.sender ? fit(displayUser(m.sender), 60) : '—'}`,
    `🕐 Yozilgan: ${formatDateTime(m.telegramDate, tz)}`,
    `📄 Turi: ${m.type} · Holat: ${m.status}`,
    m.classification ? `🏷 Tasnif: ${m.classification}` : '🏷 Tasnif: —',
    `📝 Versiyalar: ${m.versions.length} · 📎 Media: ${m.media.length} · 🤖 AI javoblar: ${m.responses.length}`,
    m.deletedAt ? `🗑 <b>O‘chirilgan:</b> ${formatDateTime(m.deletedAt, tz)}` : '🗑 O‘chirilmagan',
    '',
    `<blockquote>${fit(body(m.versions[0]), 1000)}</blockquote>`,
    '<i>Tafsilotlar juda uzun — qisqartirilgan ko‘rinish.</i>',
  ].join('\n');
}

/** `back` is the callback data of the screen this detail was opened from. */
export function buildMessageDetail(m: MessageDetail, back: string, timezone: string): View {
  let text = '';
  for (const limits of BUDGETS) {
    text = render(m, timezone, limits);
    if (text.length <= MAX_HTML) break;
  }
  // Last resort: never let show() cut the HTML mid-tag.
  if (text.length > MAX_HTML) text = renderMinimal(m, timezone);
  const kb = new Kb();
  if (m.versions.length > 1) kb.row(btn(`🕘 Barcha versiyalar (${m.versions.length})`, cb('msg.v', m.id, 0)));
  if (m.attention?.status === 'PENDING') kb.row(btn('🔔 Owner attention', cb(ROUTES.attentionOpen, m.attention.id, 'l')));
  kb.row(
    m.sender ? btn('👤 Foydalanuvchi', cb('u', m.sender.telegramUserId)) : null,
    m.sender ? btn('💬 Uning xabarlari', cb('h', 'all', 0, m.sender.telegramUserId)) : null,
  )
    .row(btn('🗑 Chat ma’lumotlarini o‘chirish', cb('pv.dc', m.chatId)))
    .back(back);
  return { text, keyboard: kb.build() };
}

export const VERSIONS_PER_PAGE = 4;

/** Every stored version of a message (paginated; each version up to ~700 chars). */
export function buildMessageVersions(m: MessageDetail, page: number, timezone: string): View {
  const info = paginate(m.versions.length, page, VERSIONS_PER_PAGE);
  const lines = [`🕘 <b>MESSAGE #${m.id}</b> — versiyalar (jami ${m.versions.length})`, ''];
  if (m.versions.length === 0) lines.push('<i>Saqlangan matn yo‘q.</i>');
  for (const v of m.versions.slice(info.skip, info.skip + VERSIONS_PER_PAGE)) {
    const when = formatDateTime(v.editedAt ?? v.createdAt, timezone);
    lines.push(`<b>v${v.version}</b>${v.version === 1 ? ' (asl)' : ''} · ${when}`, `<blockquote>${fit(body(v), 700)}</blockquote>`);
  }
  if (m.deletedAt) lines.push(`🗑 <b>O‘chirilgan:</b> ${formatDateTime(m.deletedAt, timezone)}`);
  const kb = new Kb()
    .pager(info, (p) => cb('msg.v', m.id, p))
    .back(cb(ROUTES.messageOpen, m.id, 'all', 0));
  return { text: lines.join('\n'), keyboard: kb.build() };
}
