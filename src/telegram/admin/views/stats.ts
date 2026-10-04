import type { PeriodStats, TopUser } from '../../../statistics/stats.service.js';
import { displayUser, quote } from '../../common/html.js';
import type { AdminKit } from '../kit.js';
import { Kb, btn, num, show, usd, type View } from '../ui.js';

export interface ModelUsage {
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface StatsData {
  today: PeriodStats;
  week: PeriodStats;
  topUsers: TopUser[];
  byModel: ModelUsage[];
}

function period(title: string, p: PeriodStats): string[] {
  return [
    `<b>${title}</b>`,
    `💬 Xabarlar: ${num(p.messages)} · 🤖 AI javoblar: ${num(p.aiReplies)} · 👤 Qo‘lda: ${num(p.manual)}`,
    `🔒 Shaxsiy savollar: ${num(p.personal)} · 🔔 Owner queue: ${num(p.ownerQueuePending)}`,
    `🖼 Rasmlar: ${num(p.imagesAnalyzed)} · 🎙 Ovoz: ${num(p.voiceAnalyzed)} · 🎥 Video: ${num(p.videosAnalyzed)} · ⭕ Dumaloq: ${num(p.videoNotesAnalyzed)} · 📁 Fayllar: ${num(p.documentsAnalyzed)}`,
    `✏️ Tahrirlangan: ${num(p.edited)} · 🗑 O‘chirilgan: ${num(p.deleted)} · ❌ Xatolar: ${num(p.errors)}`,
    `⏱ O‘rtacha AI javob vaqti: ${p.avgAiLatencyMs !== null ? `${(p.avgAiLatencyMs / 1000).toFixed(1)} s` : '—'}`,
    `🔢 Tokenlar: ${num(p.inputTokens)} kirish / ${num(p.outputTokens)} chiqish`,
    `💸 Taxminiy xarajat: ${usd(p.estimatedCostUsd)}`,
  ];
}

export function buildStats(d: StatsData): View {
  const lines = ['📊 <b>STATISTICS</b>', '', ...period('Bugun', d.today), '', ...period('Shu hafta (7 kun)', d.week), ''];
  lines.push('<b>🏆 Top foydalanuvchilar (hafta)</b>');
  if (d.topUsers.length === 0) lines.push('—');
  d.topUsers.forEach((u, i) => lines.push(`${i + 1}. ${quote(displayUser(u), 60)} — ${num(u.messages)}`));
  lines.push('', '<b>🧠 Modellar bo‘yicha (hafta)</b>');
  if (d.byModel.length === 0) lines.push('—');
  for (const m of [...d.byModel].sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls).slice(0, 10)) {
    lines.push(
      `• ${quote(m.provider, 20)}/${quote(m.model, 60)} — ${num(m.calls)} so‘rov, ${num(m.inputTokens)}/${num(m.outputTokens)} token, ${usd(m.costUsd)}`,
    );
  }
  lines.push('', '<i>Xarajatlar taxminiy — provayder narxlari asosida hisoblanadi.</i>');
  return { text: lines.join('\n'), keyboard: new Kb().row(btn('🔄 Yangilash', 'stt')).back().build() };
}

export function registerStats(kit: AdminKit): void {
  const { deps } = kit;
  kit.router.action('stt', async (ctx) => {
    const now = new Date();
    const todayStart = deps.stats.todayStart(now);
    const weekStart = deps.stats.weekStart(now);
    const [today, week, topUsers, byModel] = await Promise.all([
      deps.stats.period(todayStart),
      deps.stats.period(weekStart),
      deps.stats.topUsers(weekStart, 5),
      deps.stats.usageByModel(weekStart),
    ]);
    await show(ctx, buildStats({ today, week, topUsers, byModel }));
  });
}
