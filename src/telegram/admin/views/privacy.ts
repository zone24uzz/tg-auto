import type { PrivacyOverview } from '../../../privacy/privacy.service.js';
import { formatDateTime } from '../../../utils/time.js';
import { displayUser, quote } from '../../common/html.js';
import { cb } from '../callback-data.js';
import { InputError, adminIdOf, ask, type AdminKit } from '../kit.js';
import { Kb, bigId, btn, intId, num, show, type View } from '../ui.js';

const days = (d: number): string => `${d} kun`;

export function buildPrivacy(o: PrivacyOverview, timezone: string): View {
  const rawMedia = o.retainRawMedia
    ? `ha, ${days(o.mediaRetentionDays)} davomida${o.encryptionAtRest ? ' (shifrlangan)' : ''}`
    : 'saqlanmaydi';
  const session =
    o.userbotSessionStored === undefined ? '' : o.userbotSessionStored ? ' — hozir: <b>saqlangan</b>' : ' — hozir: saqlanmagan';
  const text = [
    '🔐 <b>PRIVACY</b>',
    '',
    '<b>Nimalar saqlanadi:</b>',
    '• Ulangan chatlardagi xabarlar — kontaktlarning xabarlari <b>va sizning o‘z xabarlaringiz</b>: matn, tahrir versiyalari, o‘chirilganlik holati',
    '• Bot (AI) yuborgan javoblar, tokenlar va taxminiy xarajat',
    '• Har bir chat bo‘yicha AI yozgan avtomatik xulosa (eski xabarlar konspekti)',
    '• Media tahlili natijalari (rasm tavsifi, ovoz/video transkripti, fayldan olingan matn)',
    `• Xom media fayllar: ${rawMedia}`,
    '• Kontakt profili: ism, username, teglar, izoh, rejim',
    `• Userbot rejimida (TELEGRAM_TRANSPORT=userbot): akkauntingizga <b>to‘liq kirish</b> huquqini beruvchi MTProto sessiyasi (shifrlangan)${session}`,
    '',
    '<b>Sozlangan AI provayderga yuboriladi:</b>',
    '• Javob uchun: chat tarixi (kontakt xabarlari, sizning va botning javoblari), avtomatik xulosa va yangi xabar',
    '• Tahlil uchun: rasmlar, video kadrlari, ovozli xabar/audio (transkripsiya uchun), hujjat matni; natijadagi tavsif va transkriptlar keyingi javoblarga ham qo‘shiladi',
    '• Xulosa uchun: eski xabarlar va oldingi xulosa',
    'AI provayder — uchinchi tomon: bu ma’lumotlar uning serverlarida, uning shartlariga ko‘ra qayta ishlanadi. Boshqa hech kimga berilmaydi.',
    '',
    `🔒 Shifrlash (at rest): ${o.encryptionAtRest ? '✅ yoqilgan' : '❌ o‘chirilgan (DATA_ENCRYPTION_KEY o‘rnatilmagan)'}`,
    `🗄 Saqlash muddati: xabarlar ${days(o.messageRetentionDays)} · media ${days(o.mediaRetentionDays)} · AI loglar ${days(o.aiLogRetentionDays)}`,
    `📊 Hozir saqlangan: ${num(o.storedMessages)} xabar · ${num(o.storedUsers)} foydalanuvchi · ${num(o.storedMediaFiles)} media fayl`,
    `🕐 Eng eski xabar: ${o.oldestMessageAt ? formatDateTime(o.oldestMessageAt, timezone) : '—'}`,
    '',
    'ℹ️ Business rejimida faqat botga ulashilgan chatlar, userbot rejimida akkauntingizning barcha shaxsiy chatlari qayta ishlanadi.',
    'ℹ️ O‘chirilgan xabarlar haqida faqat bot ulangandan keyin kelgan xabarlar uchun ma’lumot bo‘ladi.',
  ].join('\n');
  const kb = new Kb()
    .row(btn('🗑 Foydalanuvchi ma’lumotlarini o‘chirish', 'pv.d'))
    .row(btn('🗄 Saqlash muddati', 'adv.r'), btn('🧹 Tozalash', 'adv.cl'))
    .back();
  return { text, keyboard: kb.build() };
}

export function buildDeleteUserConfirm(id: bigint, user: { label: string; messageCount: number } | null): View {
  const who = user ? `${quote(user.label, 80)} (<code>${id.toString()}</code>)` : `<code>${id.toString()}</code>`;
  const text = [
    '⚠️ <b>Ma’lumotlarni o‘chirish</b>',
    '',
    `${who} bilan bog‘liq barcha saqlangan ma’lumotlar${user ? ` (~${num(user.messageCount)} xabar)` : ''}: xabarlar, versiyalar, media, AI javoblari, xulosalar va profil <b>butunlay o‘chiriladi</b>.`,
    'Buni qaytarib bo‘lmaydi. Allowlist/blocklist qoidalari saqlanib qoladi.',
  ].join('\n');
  const kb = new Kb().row(btn('✅ Ha, o‘chirish', cb('pv.dy', id)), btn('❌ Yo‘q', user ? cb('u', id) : 'pv'));
  return { text, keyboard: kb.build() };
}

export function buildDeleteChatConfirm(chatId: number, messages: number): View {
  return {
    text: `⚠️ <b>Chat ma’lumotlarini o‘chirish</b>\n\nShu chatdagi ${num(messages)} ta saqlangan xabar (versiyalar, media, AI javoblari, xulosa bilan) <b>butunlay o‘chiriladi</b>. Buni qaytarib bo‘lmaydi.`,
    keyboard: new Kb().row(btn('✅ Ha, o‘chirish', cb('pv.dcy', chatId)), btn('❌ Yo‘q', 'pv')).build(),
  };
}

export function buildDeleted(result: { messages: number; chats: number }): View {
  return {
    text: `✅ O‘chirildi: ${num(result.messages)} xabar, ${num(result.chats)} chat.`,
    keyboard: new Kb().back('pv').build(),
  };
}

export function registerPrivacy(kit: AdminKit): void {
  const { router, deps } = kit;

  router.action('pv', async (ctx) => {
    const overview = await deps.privacy.overview(await deps.settings.get());
    await show(ctx, buildPrivacy(overview, deps.timezone));
  });

  router.action('pv.d', async (ctx) => {
    await ask(
      kit,
      ctx,
      'pv.user',
      { back: 'pv' },
      '🗑 Ma’lumotlari o‘chiriladigan foydalanuvchining raqamli Telegram ID sini yoki <code>@username</code> ini yuboring.\nKeyingi qadamda tasdiqlash so‘raladi.',
    );
  });

  router.input('pv.user', async (ctx, text) => {
    const t = text.trim();
    let id = /^\d{1,20}$/.test(t) ? BigInt(t) : null;
    if (id === null) {
      const name = t.replace(/^@/, '').toLowerCase();
      if (!/^[a-z0-9_]{3,32}$/.test(name)) throw new InputError('Raqamli ID yoki @username yuboring.');
      const found = (await deps.users.search(name, 10)).find((s) => s.user.username?.toLowerCase() === name);
      if (!found) throw new InputError('Bunday username bilan foydalanuvchi topilmadi. Raqamli ID ni yuboring.');
      id = found.user.telegramUserId;
    }
    await router.go(ctx, cb('pv.du', id));
  });

  router.action('pv.du', async (ctx, [raw]) => {
    const id = bigId(raw);
    if (id === null) return { text: 'Bu tugma eskirgan.', alert: true };
    const summary = await deps.users.byTelegramId(id);
    await show(
      ctx,
      buildDeleteUserConfirm(id, summary ? { label: displayUser(summary.user), messageCount: summary.user.messageCount } : null),
    );
  });

  router.action('pv.dy', async (ctx, [raw]) => {
    const id = bigId(raw);
    if (id === null) return { text: 'Bu tugma eskirgan.', alert: true };
    const result = await deps.privacy.deleteUserData(id, adminIdOf(kit, ctx));
    await show(ctx, buildDeleted(result));
    return '🗑 O‘chirildi';
  });

  router.action('pv.dc', async (ctx, [raw]) => {
    const chatId = intId(raw);
    const chat = chatId === null ? null : await deps.db.chat.findUnique({ where: { id: chatId }, select: { id: true } });
    if (!chat) return { text: 'Chat topilmadi (allaqachon o‘chirilgan bo‘lishi mumkin).', alert: true };
    const messages = await deps.db.message.count({ where: { chatId: chat.id } });
    await show(ctx, buildDeleteChatConfirm(chat.id, messages));
  });

  router.action('pv.dcy', async (ctx, [raw]) => {
    const chatId = intId(raw);
    if (chatId === null) return { text: 'Bu tugma eskirgan.', alert: true };
    const result = await deps.privacy.deleteChatData(chatId, adminIdOf(kit, ctx));
    await show(ctx, buildDeleted(result));
    return '🗑 O‘chirildi';
  });
}
