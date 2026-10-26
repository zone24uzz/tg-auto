import { availabilityOf, fillNotice } from '../../../features/availability.js';
import type { Settings } from '../../../settings/schema.js';
import type { Context } from 'grammy';
import { formatDateTime, formatTime } from '../../../utils/time.js';
import { quote } from '../../common/html.js';
import { cb, ROUTES } from '../callback-data.js';
import { choiceBtn, editBtn, toggleBtn } from '../controls.js';
import { adminIdOf, setSetting, type AdminKit } from '../kit.js';
import { Kb, NOP, btn, check, show, yesNo, type View } from '../ui.js';
import { isSuperAdmin } from './access.js';

const DAY_LABELS = ['Ya', 'Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh'];
/** Display order Monday → Sunday. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const SUMMARY_TIMES = ['07:00', '08:00', '09:00'] as const;
const START_TIMES = ['08:00', '09:00', '10:00'] as const;
const END_TIMES = ['18:00', '20:00', '21:00', '22:00'] as const;
const BUSY_MINUTES = [30, 60, 120, 180] as const;
const OFF_MODE_LABEL: Record<Settings['offHoursMode'], string> = {
  NOTICE: 'xabar yuborib, menga',
  AI: 'AI odatdagidek javob beradi',
  SILENT: 'jim, faqat menga',
};

function busyLine(s: Settings, now: Date, timezone: string): string {
  const a = availabilityOf(s, now, timezone);
  return a.busy ? `⏳ <b>${formatTime(a.busy.until, timezone)} gacha band</b>${a.busy.note ? ` (${quote(a.busy.note, 60)})` : ''}` : '🟢 Band emas';
}

export function buildFeatures(s: Settings, now: Date, timezone: string, opts: { backup?: boolean } = {}): View {
  const backup = opts.backup !== false;
  const work = s.workHoursEnabled ? `${s.workStart}–${s.workEnd}` : 'o‘chiq';
  const text = [
    '✨ <b>YORDAMCHI FUNKSIYALAR</b>',
    '',
    `✍️ Uslubim: ${s.styleProfile ? `o‘rganilgan${s.styleLearnedAt ? ` (${formatDateTime(new Date(s.styleLearnedAt), timezone)})` : ''}` : 'hali o‘rganilmagan'} · ishlatish: ${yesNo(s.useStyleProfile)}`,
    `📝 Javob qoralamalari (shaxsiy savollarga 2–3 tayyor javob): ${yesNo(s.replyDraftsEnabled)}`,
    `🌐 Mijoz tilida javob: ✅ doim (o‘zbek lotin/kirill, rus, ingliz)`,
    `🕘 Ish vaqti: <b>${work}</b>`,
    `⏳ Bandman: ${busyLine(s, now, timezone)}`,
    `🛡 Firibgarlikdan himoya: ${yesNo(s.scamProtectionEnabled)} · ogohlantirish: ${yesNo(s.scamWarnOwner)}`,
    `☀️ Ertalabki xulosa: ${s.morningSummaryEnabled ? `<b>${s.morningSummaryTime}</b>` : 'o‘chiq'} · 🎂 tug‘ilgan kunlar: ${yesNo(s.birthdayRemindersEnabled)}`,
    backup ? `💾 Kunlik zaxira nusxa (tunda, shu chatga): ${yesNo(s.dailyBackupEnabled)}` : null,
    '',
    '<i>Assistentga oddiy yozsangiz ham bo‘ladi: «2 soat uchrashuvdaman», «uslubimni o‘rgan», «Alining tug‘ilgan kuni 12-mart», «bugungi xulosa».</i>',
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
  const kb = new Kb()
    .row(toggleBtn('xsp', s.useStyleProfile, 'Uslubim'), btn('✍️ Hozir o‘rganish', 'fx.ls'))
    .row(toggleBtn('xrd', s.replyDraftsEnabled, 'Javob qoralamalari'))
    .row(btn('🕘 Ish vaqti', 'fx.w'), btn('⏳ Bandman', 'fx.b'))
    .row(toggleBtn('xsc', s.scamProtectionEnabled, 'Himoya'), toggleBtn('xsw', s.scamWarnOwner, 'Ogohlantirish'))
    .row(toggleBtn('xms', s.morningSummaryEnabled, 'Ertalabki xulosa'), btn('👁 Ko‘rish', 'fx.ms'))
    .row(...SUMMARY_TIMES.map((t) => choiceBtn('xmt', t, s.morningSummaryTime === t, t)), editBtn('xmt', ''))
    .row(toggleBtn('xbd', s.birthdayRemindersEnabled, 'Tug‘ilgan kunlar'))
    .row(backup ? toggleBtn('xbk', s.dailyBackupEnabled, 'Kunlik zaxira') : null, backup ? btn('💾 Hozir', 'fx.bk') : null)
    .back();
  return { text, keyboard: kb.build() };
}

export function buildWorkHours(s: Settings): View {
  const off = DAY_ORDER.filter((d) => s.weekendDays.includes(d)).map((d) => DAY_LABELS[d]);
  const text = [
    '🕘 <b>ISH VAQTI</b>',
    '',
    `Holat: ${yesNo(s.workHoursEnabled)}`,
    `Vaqt: <b>${s.workStart}–${s.workEnd}</b>`,
    `Dam olish kunlari: <b>${off.length ? off.join(', ') : 'yo‘q'}</b> (butun kun ish vaqtidan tashqari)`,
    `Ish vaqtidan tashqari: <b>${OFF_MODE_LABEL[s.offHoursMode]}</b>`,
    '',
    'Mijozga boradigan xabar (bir kechada bir marta):',
    `<blockquote>${quote(fillNotice(s.offHoursText, { owner: s.ownerName, start: s.workStart, timezone: 'UTC' }), 500)}</blockquote>`,
    '<i>Xabarlar navbatingizga tushadi (ovozsiz bildirishnoma) — ertalab tayyor javob variantlari bilan.</i>',
  ].join('\n');
  const kb = new Kb()
    .row(toggleBtn('xwe', s.workHoursEnabled, 'Ish vaqti yoqilgan'))
    .row(btn('Boshlanish:', NOP), ...START_TIMES.map((t) => choiceBtn('xws', t, s.workStart === t, t)), editBtn('xws', ''))
    .row(btn('Tugash:', NOP), ...END_TIMES.map((t) => choiceBtn('xwn', t, s.workEnd === t, t)), editBtn('xwn', ''))
    .row(...DAY_ORDER.map((d) => btn(check(s.weekendDays.includes(d), DAY_LABELS[d]!), cb('fx.wd', d))))
    .row(choiceBtn('xom', 'NOTICE', s.offHoursMode === 'NOTICE', 'Xabar + menga'))
    .row(choiceBtn('xom', 'AI', s.offHoursMode === 'AI', 'AI javob bersin'), choiceBtn('xom', 'SILENT', s.offHoursMode === 'SILENT', 'Jim'))
    .row(editBtn('xot', 'Xabar matni'))
    .back('fx');
  return { text, keyboard: kb.build() };
}

export function buildBusy(s: Settings, now: Date, timezone: string): View {
  const a = availabilityOf(s, now, timezone);
  const preview = fillNotice(s.busyReplyText, {
    owner: s.ownerName,
    note: a.busy?.note ?? 'uchrashuvda',
    until: a.busy?.until ?? new Date(now.getTime() + 3_600_000),
    timezone,
  });
  const text = [
    '⏳ <b>«BANDMAN» REJIMI</b>',
    '',
    `Holat: ${busyLine(s, now, timezone)}`,
    '',
    'Yoqilganda shaxsiy savollarga mijozga shunday javob boradi, oddiy savollarga AI odatdagidek javob beradi va kerak bo‘lsa bandligingizni aytadi:',
    `<blockquote>${quote(preview, 500)}</blockquote>`,
    '<i>Tezroq: assistentga «2 soat uchrashuvdaman» yoki «17:00 gacha bandman» deb yozing — sababi ham saqlanadi.</i>',
  ].join('\n');
  const kb = new Kb()
    .row(...BUSY_MINUTES.map((m) => btn(m < 60 ? `${m} daq` : `${m / 60} soat`, cb('fx.bs', m))))
    .row(a.busy ? btn('🟢 Bo‘shadim (o‘chirish)', 'fx.bo') : null)
    .row(editBtn('xbt', 'Xabar matni'))
    .back('fx');
  return { text, keyboard: kb.build() };
}

export function registerFeatures(kit: AdminKit): void {
  const { router, deps } = kit;
  const settings = () => deps.settings.get();

  const showFeatures = async (ctx: Context) =>
    show(ctx, buildFeatures(await settings(), new Date(), deps.timezone, { backup: isSuperAdmin(kit, ctx) }));
  router.action('fx', async (ctx) => {
    await showFeatures(ctx);
  });
  router.action('fx.w', async (ctx) => {
    await show(ctx, buildWorkHours(await settings()));
  });
  router.action('fx.b', async (ctx) => {
    await show(ctx, buildBusy(await settings(), new Date(), deps.timezone));
  });

  router.action('fx.wd', async (ctx, [raw]) => {
    const day = Number(raw);
    if (!Number.isInteger(day) || day < 0 || day > 6) return { text: 'Bu tugma eskirgan.', alert: true };
    const current = (await settings()).weekendDays;
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort();
    await setSetting(kit, ctx, 'weekendDays', next);
    await show(ctx, buildWorkHours(await settings()));
    return '✅ Saqlandi';
  });

  router.action('fx.bs', async (ctx, [raw]) => {
    const minutes = Number(raw);
    if (!deps.daily || !Number.isInteger(minutes) || minutes <= 0 || minutes > 24 * 60) return { text: 'Bu tugma eskirgan.', alert: true };
    adminIdOf(kit, ctx);
    await deps.daily.setBusy(new Date(Date.now() + minutes * 60_000), '');
    await show(ctx, buildBusy(await settings(), new Date(), deps.timezone));
    return '⏳ Bandman rejimi yoqildi';
  });

  router.action('fx.bo', async (ctx) => {
    if (!deps.daily) return { text: 'Bu tugma eskirgan.', alert: true };
    adminIdOf(kit, ctx);
    await deps.daily.clearBusy();
    await show(ctx, buildBusy(await settings(), new Date(), deps.timezone));
    return '🟢 O‘chirildi';
  });

  router.action('fx.ms', async (ctx) => {
    if (!deps.daily) return { text: 'Bu funksiya ulanmagan.', alert: true };
    const { text } = await deps.daily.morningSummaryText();
    await show(ctx, { text, keyboard: new Kb().row(btn('⬅️ Orqaga', 'fx')).build() }, { fresh: true });
  });

  router.action('fx.bk', async (ctx) => {
    if (!deps.daily || !isSuperAdmin(kit, ctx)) return { text: '💾 Faqat bot administratori uchun.', alert: true };
    adminIdOf(kit, ctx);
    const daily = deps.daily;
    // Building and uploading the file can take a while: answer the button first.
    void daily
      .sendBackup()
      .then((line) => show(ctx, { text: line, keyboard: new Kb().row(btn('⬅️ Orqaga', 'fx')).build() }, { fresh: true }))
      .catch(() => undefined);
    return '💾 Zaxira tayyorlanmoqda…';
  });

  router.action('fx.ls', async (ctx) => {
    if (!deps.style) return { text: 'Bu funksiya ulanmagan.', alert: true };
    adminIdOf(kit, ctx);
    const style = deps.style;
    void style
      .learn()
      .then(async (r) => {
        const text = r.ok
          ? `✍️ <b>Uslubingizni o‘rgandim</b> (${r.messages} ta xabaringizdan):\n\n${quote(r.profile, 1200)}`
          : r.reason === 'too_few'
            ? `✍️ Kamida 20 ta o‘zingiz yozgan xabar kerak (hozir ${r.messages} ta).`
            : '❌ AI hozir javob bermadi. Birozdan keyin urinib ko‘ring.';
        await show(ctx, { text, keyboard: new Kb().row(btn('⬅️ Orqaga', 'fx')).build() }, { fresh: true });
      })
      .catch(() => undefined);
    return '✍️ O‘rganyapman…';
  });

  /** Scam warning → block the sender (no more replies or notifications from them). */
  router.action(ROUTES.scamBlock, async (ctx, [raw]) => {
    if (!raw || !/^\d{1,20}$/.test(raw)) return { text: 'Bu tugma eskirgan.', alert: true };
    await deps.users.setMode(BigInt(raw), 'BLOCK', adminIdOf(kit, ctx));
    await ctx.editMessageReplyMarkup({ reply_markup: new Kb().row(btn('🚫 Bloklandi', NOP)).build() }).catch(() => undefined);
    return '🚫 Bloklandi';
  });
}
