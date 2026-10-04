import type { CleanupReport } from '../../../retention/cleanup.service.js';
import { formatDateTime } from '../../../utils/time.js';
import { adminIdOf, type AdminKit } from '../kit.js';
import { Kb, ack, btn, num, show, yesNo, type View } from '../ui.js';

export function buildCleanupConfirm(lastCleanupAt: string | null, timezone: string): View {
  const last = lastCleanupAt ? formatDateTime(new Date(lastCleanupAt), timezone) : 'hali ishga tushmagan';
  return {
    text: [
      '🧹 <b>Tozalashni hozir ishga tushirasizmi?</b>',
      '',
      'Saqlash muddati o‘tgan xabarlar, media fayllar, AI loglar va eski texnik yozuvlar <b>butunlay o‘chiriladi</b>. Buni qaytarib bo‘lmaydi.',
      '',
      `Oxirgi tozalash: ${last}`,
    ].join('\n'),
    keyboard: new Kb().row(btn('✅ Ha, tozalash', 'adv.cly'), btn('❌ Yo‘q', 'adv')).build(),
  };
}

export function buildCleanupReport(r: CleanupReport): View {
  const text = [
    '🧹 <b>Tozalash tugadi</b>',
    '',
    `💬 Xabarlar: ${num(r.messages)}`,
    `👤 Faol bo‘lmagan profillar: ${num(r.orphanUsers)}`,
    `📎 Media fayllar: ${num(r.mediaFiles)} · vaqtinchalik fayllar: ${num(r.tempFiles)}`,
    `🤖 Usage yozuvlari: ${num(r.usageRows)} · tizim hodisalari: ${num(r.events)}`,
    `⚙️ Update’lar: ${num(r.processedUpdates)} · job’lar: ${num(r.jobs)} · admin holatlari: ${num(r.adminStates)}`,
    `❔ Natijasi noma’lum javoblar (UNCERTAIN deb belgilandi): ${num(r.uncertainResponses)}`,
  ].join('\n');
  return { text, keyboard: new Kb().back('adv').build() };
}

export interface ConnectionRow {
  isEnabled: boolean;
  canReply: boolean;
  connectedAt: Date;
  updatedAt: Date;
}

export function buildConnections(rows: ConnectionRow[], timezone: string): View {
  const lines = ['🔌 <b>TELEGRAM BUSINESS ULANISHI</b>', ''];
  if (rows.length === 0) {
    lines.push(
      '⚪ Ulanish yo‘q.',
      '',
      'Telegram → Sozlamalar → Telegram Business → Chatbotlar bo‘limida shu botni ulang va «javob berish» huquqini bering.',
    );
  }
  for (const c of rows) {
    lines.push(
      `${c.isEnabled ? '🟢 Yoqilgan' : '🔴 O‘chirilgan'} · ✍️ Javob berish huquqi: ${yesNo(c.canReply)}`,
      `   Ulangan: ${formatDateTime(c.connectedAt, timezone)} · yangilangan: ${formatDateTime(c.updatedAt, timezone)}`,
    );
  }
  if (rows.some((c) => c.isEnabled && !c.canReply)) {
    lines.push('', '⚠️ Bot xabarlarni o‘qiy oladi, lekin javob bera olmaydi — Chatbotlar sozlamasida ruxsat bering.');
  }
  return { text: lines.join('\n'), keyboard: new Kb().row(btn('🔄 Yangilash', 'adv.cn')).back('adv').build() };
}

export function registerMaintenance(kit: AdminKit): void {
  const { router, deps } = kit;

  router.action('adv.cl', async (ctx) => {
    const s = await deps.settings.get();
    await show(ctx, buildCleanupConfirm(s.lastCleanupAt, deps.timezone));
  });

  router.action('adv.cly', async (ctx) => {
    adminIdOf(kit, ctx);
    await ack(ctx, '🧹 Tozalanmoqda…');
    await show(ctx, { text: '🧹 Tozalanmoqda… bu biroz vaqt olishi mumkin.', keyboard: new Kb().build() });
    const report = await deps.cleanup.run(await deps.settings.get());
    await deps.settings.set('lastCleanupAt', new Date().toISOString()).catch(() => undefined);
    await show(ctx, buildCleanupReport(report));
  });

  router.action('adv.cn', async (ctx) => {
    await show(ctx, buildConnections(await deps.connections.listAuthorized(), deps.timezone));
  });
}
