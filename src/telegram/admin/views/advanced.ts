import { DELAY_MODES, type Settings } from '../../../settings/schema.js';
import { escapeHtml, quote } from '../../common/html.js';
import { choiceBtn, editBtn, presetBtns, toggleBtn } from '../controls.js';
import type { AdminKit } from '../kit.js';
import { Kb, NOP, btn, num, show, usd, yesNo, type View } from '../ui.js';

const DELAY_INFO: Record<(typeof DELAY_MODES)[number], { label: string; desc: string }> = {
  OFF: { label: 'Off', desc: 'darhol javob' },
  FAST: { label: 'Fast', desc: 'bir necha soniya' },
  NATURAL: { label: 'Natural', desc: 'javob uzunligiga qarab, odamga o‘xshab' },
  CUSTOM: { label: 'Custom', desc: 'pastdagi min/maks oralig‘ida tasodifiy' },
};

const days = (d: number): string => (d === 0 ? 'darhol' : d >= 365 && d % 365 === 0 ? `${d / 365} yil` : `${d} kun`);
const dShort = (d: number): string => (d >= 365 && d % 365 === 0 ? `${d / 365}y` : `${d}d`);

export function buildAdvanced(s: Settings): View {
  const text = [
    '⚙️ <b>ADVANCED SETTINGS</b>',
    '',
    `👤 Egasining ismi: <b>${escapeHtml(s.ownerName)}</b>`,
    `⏱ Kechikish: <b>${DELAY_INFO[s.responseDelayMode].label}</b> · typing: ${yesNo(s.typingIndicator)}`,
    `🧠 Kontekst: ${s.historyWindow} xabar · kutish ${s.debounceSeconds} s · xulosa ${yesNo(s.summaryEnabled)}`,
    `🚦 Kunlik AI limiti: ${s.maxDailyAiCostUsd > 0 ? usd(s.maxDailyAiCostUsd) : 'cheksiz'}`,
    `🗄 Saqlash: xabarlar ${days(s.messageRetentionDays)} · media ${days(s.mediaRetentionDays)}`,
    '',
    'Zaxira javob matni (AI ishlamay qolganda):',
    `<blockquote>${quote(s.fallbackReplyText, 500)}</blockquote>`,
  ].join('\n');
  const kb = new Kb()
    .row(btn('⏱ Kechikish va typing', 'adv.d'), btn('🧠 Kontekst', 'adv.c'))
    .row(btn('🚦 Limitlar', 'adv.l'), btn('🗄 Saqlash muddati', 'adv.r'))
    .row(btn('🔔 Bildirishnomalar', 'adv.n'), btn('🔌 Business ulanishi', 'adv.cn'))
    .row(editBtn('on', 'Egasining ismi'), editBtn('fbt', 'Zaxira javob'))
    .row(btn('🧹 Tozalashni hozir ishga tushirish', 'adv.cl'))
    .back();
  return { text, keyboard: kb.build() };
}

export function buildDelay(s: Settings): View {
  const lines = ['⏱ <b>KECHIKISH VA TYPING</b>', ''];
  for (const m of DELAY_MODES) lines.push(`${m === s.responseDelayMode ? '🔵' : '⚪'} <b>${DELAY_INFO[m].label}</b> — ${DELAY_INFO[m].desc}`);
  if (s.responseDelayMode === 'CUSTOM') {
    lines.push('', `Oraliq: <b>${s.customDelayMinSec}–${s.customDelayMaxSec} s</b>`);
    if (s.customDelayMinSec > s.customDelayMaxSec) lines.push('ℹ️ Min. qiymat maks. dan katta — ular o‘rni almashtirilib ishlatiladi.');
  }
  lines.push('', `«Yozmoqda…» ko‘rsatkichi: ${yesNo(s.typingIndicator)}`);
  const kb = new Kb().row(...DELAY_MODES.map((m) => choiceBtn('dm', m, s.responseDelayMode === m, DELAY_INFO[m].label)));
  if (s.responseDelayMode === 'CUSTOM') {
    kb.row(btn('Min:', NOP), ...presetBtns('dmn', [0, 1, 2, 3, 5], s.customDelayMinSec, (v) => `${v}s`), editBtn('dmn', ''));
    kb.row(btn('Maks:', NOP), ...presetBtns('dmx', [3, 5, 8, 12, 20], s.customDelayMaxSec, (v) => `${v}s`), editBtn('dmx', ''));
  }
  kb.row(toggleBtn('ti', s.typingIndicator, '«Yozmoqda…» ko‘rsatkichi')).back('adv');
  return { text: lines.join('\n'), keyboard: kb.build() };
}

export function buildContext(s: Settings): View {
  const text = [
    '🧠 <b>KONTEKST</b>',
    '',
    `⏳ Ketma-ket xabarlarni kutish: <b>${s.debounceSeconds} s</b> — bir nechta xabar kelsa, bitta javob beriladi`,
    `📚 Kontekst oynasi: <b>${s.historyWindow}</b> ta oxirgi xabar`,
    `📝 Suhbat xulosasi: ${yesNo(s.summaryEnabled)} · har <b>${s.summaryEveryMessages}</b> xabarda yangilanadi`,
  ].join('\n');
  const kb = new Kb()
    .row(btn('⏳', NOP), ...presetBtns('db', [0, 2, 4, 8], s.debounceSeconds, (v) => `${v}s`))
    .row(btn('📚', NOP), ...presetBtns('hw', [10, 20, 30], s.historyWindow))
    .row(toggleBtn('se', s.summaryEnabled, 'Suhbat xulosasi'))
    .row(btn('📝', NOP), ...presetBtns('sem', [20, 40, 80, 150], s.summaryEveryMessages))
    .back('adv');
  return { text, keyboard: kb.build() };
}

export function buildLimits(s: Settings, costToday: number): View {
  const text = [
    '🚦 <b>LIMITLAR</b>',
    '',
    `💬 Bitta chatdan daqiqasiga maks. xabar: <b>${num(s.maxMessagesPerMinute)}</b>`,
    `👤 Bitta foydalanuvchiga soatiga AI so‘rov: <b>${num(s.maxAiRequestsPerUserPerHour)}</b>`,
    `🌐 Umumiy AI so‘rov / daqiqa: <b>${num(s.globalAiRequestsPerMinute)}</b>`,
    `💸 Kunlik AI xarajat limiti: <b>${s.maxDailyAiCostUsd > 0 ? usd(s.maxDailyAiCostUsd) : 'cheksiz (0)'}</b> · bugun: ${usd(costToday)}`,
    '',
    'Limit oshsa AI javob bermaydi va xabar sizga yuboriladi.',
  ].join('\n');
  const kb = new Kb()
    .row(btn('💬', NOP), ...presetBtns('mpm', [5, 10, 20, 60], s.maxMessagesPerMinute), editBtn('mpm', ''))
    .row(btn('👤', NOP), ...presetBtns('apu', [20, 50, 100, 500], s.maxAiRequestsPerUserPerHour), editBtn('apu', ''))
    .row(btn('🌐', NOP), ...presetBtns('gai', [10, 30, 60, 120], s.globalAiRequestsPerMinute), editBtn('gai', ''))
    .row(btn('💸', NOP), ...presetBtns('mc', [0.5, 1, 2, 5, 10], s.maxDailyAiCostUsd, (v) => `$${v}`))
    .row(choiceBtn('mc', 0, s.maxDailyAiCostUsd === 0, '♾ Cheksiz'), editBtn('mc', 'Boshqa summa'))
    .back('adv');
  return { text, keyboard: kb.build() };
}

export function buildRetention(s: Settings): View {
  const text = [
    '🗄 <b>SAQLASH MUDDATI</b>',
    '',
    `💬 Xabarlar: <b>${days(s.messageRetentionDays)}</b>`,
    `🗃 Xom media fayllarni saqlash: ${yesNo(s.retainRawMedia)}`,
    `📎 Xom media muddati: <b>${days(s.mediaRetentionDays)}</b> (faqat saqlash yoqilgan bo‘lsa; 0 — saqlanmaydi)`,
    `🤖 AI loglar va statistika: <b>${days(s.aiLogRetentionDays)}</b>`,
    '',
    'Muddati o‘tgan ma’lumotlar avtomatik tozalanadi (yoki ⚙️ → 🧹 orqali hozir).',
  ].join('\n');
  const kb = new Kb()
    .row(btn('💬', NOP), ...presetBtns('mr', [7, 30, 90, 365], s.messageRetentionDays, dShort))
    .row(btn('📎', NOP), ...presetBtns('mdr', [0, 1, 3, 7, 30], s.mediaRetentionDays, dShort))
    .row(btn('🤖', NOP), ...presetBtns('alr', [7, 30, 90, 365], s.aiLogRetentionDays, dShort))
    .row(toggleBtn('rrm', s.retainRawMedia, 'Xom media fayllarni saqlash'))
    .back('adv');
  return { text, keyboard: kb.build() };
}

export function buildNotifications(s: Settings): View {
  const text = [
    '🔔 <b>BILDIRISHNOMALAR</b>',
    '',
    'Qaysi hodisalar haqida shu botga xabar kelsin:',
    `✏️ Xabar tahrirlanganda: ${yesNo(s.notifyEdits)}`,
    `🗑 Xabar o‘chirilganda: ${yesNo(s.notifyDeletes)}`,
    `🔔 Javobingiz kerak bo‘lganda (owner attention): ${yesNo(s.notifyOwnerAttention)}`,
    `👤 Manual foydalanuvchilar yozganda: ${yesNo(s.notifyManualMessages)}`,
    `⭐ VIP foydalanuvchilar yozganda: ${yesNo(s.notifyVipMessages)}`,
    `🔴 Avtojavob o‘chiq paytda: ${yesNo(s.notifyWhenDisabled)}`,
  ].join('\n');
  const kb = new Kb()
    .row(toggleBtn('ne', s.notifyEdits, 'Tahrirlar'), toggleBtn('nd', s.notifyDeletes, 'O‘chirishlar'))
    .row(toggleBtn('noa', s.notifyOwnerAttention, 'Owner attention'))
    .row(toggleBtn('nm', s.notifyManualMessages, 'Manual', 'adv.n'), toggleBtn('nv', s.notifyVipMessages, 'VIP', 'adv.n'))
    .row(toggleBtn('nw', s.notifyWhenDisabled, 'O‘chiq paytda', 'adv.n'))
    .back('adv');
  return { text, keyboard: kb.build() };
}

export function registerAdvanced(kit: AdminKit): void {
  const { router, deps } = kit;
  const screens: Record<string, (s: Settings) => View> = {
    adv: buildAdvanced,
    'adv.d': buildDelay,
    'adv.c': buildContext,
    'adv.r': buildRetention,
    'adv.n': buildNotifications,
  };
  for (const [route, build] of Object.entries(screens)) {
    router.action(route, async (ctx) => {
      await show(ctx, build(await deps.settings.get()));
    });
  }
  router.action('adv.l', async (ctx) => {
    const [s, cost] = await Promise.all([deps.settings.get(), deps.usage.costToday()]);
    await show(ctx, buildLimits(s, cost));
  });
}
