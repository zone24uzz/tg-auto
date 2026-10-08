import type { Context } from 'grammy';
import { EXTRA_REASON_LABELS, type AttentionView } from '../../../owner-attention/attention.service.js';
import { formatDateTime, timeAgo } from '../../../utils/time.js';
import { quote } from '../../common/html.js';
import { cb, ROUTES } from '../callback-data.js';
import { adminIdOf, ask, type AdminKit } from '../kit.js';
import { reasonLabel } from '../notifier.js';
import { Kb, NOP, btn, fit, intId, label, loadPage, pageArg, setNotice, show, type PageInfo, type View } from '../ui.js';
import { attentionStatusLabel } from './labels.js';

const PER_PAGE = 6;
const RESOLVED = 'ℹ️ Bu xabar allaqachon hal qilingan.';

export type AttentionItem = Pick<
  AttentionView,
  'id' | 'status' | 'reason' | 'detail' | 'createdAt' | 'messageId' | 'text' | 'userLabel' | 'senderTelegramUserId'
> &
  Partial<Pick<AttentionView, 'uncertainDelivery'>>;

const MAY_HAVE_BEEN_DELIVERED =
  '⚠️ Avvalgi javob mijozga yetib borgan bo‘lishi mumkin (Telegram natijani tasdiqlamadi). Avval chatni tekshiring.';

function attentionReasonLabel(reason: string): string {
  return EXTRA_REASON_LABELS[reason] ?? reasonLabel(reason);
}

export function buildAttentionList(items: AttentionItem[], info: PageInfo, now: Date): View {
  const text = [
    `🔔 <b>OWNER ATTENTION</b> — kutilmoqda: <b>${info.total}</b>`,
    '',
    info.total === 0
      ? '✅ Navbat bo‘sh. Sizning javobingizni kutayotgan xabar yo‘q.'
      : 'Shaxsiy savollar, VIP va AI javob bera olmagan xabarlar. Ko‘rish uchun tanlang:',
  ].join('\n');
  const kb = new Kb();
  for (const it of items) {
    kb.row(btn(label(`🔔 ${it.userLabel} · ${timeAgo(it.createdAt, now)} · ${it.text}`, 60), cb(ROUTES.attentionOpen, it.id, 'l')));
  }
  kb.pager(info, (p) => cb('oa.l', p)).back();
  return { text, keyboard: kb.build() };
}

export function buildAttentionItem(it: AttentionItem, now: Date, timezone: string): View {
  const pending = it.status === 'PENDING';
  const lines = [
    `🔔 <b>OWNER ATTENTION #${it.id}</b>`,
    '',
    `👤 Foydalanuvchi: ${quote(it.userLabel, 80)}`,
    `🕐 Vaqt: ${formatDateTime(it.createdAt, timezone)} (${timeAgo(it.createdAt, now)})`,
    `Sabab: ${quote(attentionReasonLabel(it.reason), 100)}${it.detail ? ` — <i>${fit(it.detail, 300)}</i>` : ''}`,
    `Holat: ${attentionStatusLabel(it.status)}`,
    '',
    '💬 Xabar:',
    `«${fit(it.text, 1500)}»`,
  ];
  if (pending && it.uncertainDelivery) lines.push('', MAY_HAVE_BEEN_DELIVERED);
  if (!pending) lines.push('', RESOLVED);
  const kb = new Kb();
  if (pending) {
    if (it.reason === 'TOOL_APPROVAL_1') {
      const call = JSON.parse(it.detail || '{}');
      lines.push('', `🛠 <b>AI amal bajarmokchi:</b> <code>${call.name}</code>`, `<b>Parametrlar:</b> <pre>${JSON.stringify(call.args, null, 2)}</pre>`);
      kb.row(btn('✅ Ruxsat berish (1-bosqich)', cb(ROUTES.attentionAi, it.id, 't1')))
        .row(btn('🚫 Rad etish', cb(ROUTES.attentionIgnore, it.id, 'v')));
    } else if (it.reason === 'TOOL_APPROVAL_2') {
      const call = JSON.parse(it.detail || '{}');
      lines.push('', `🚨 <b>Xavfsizlik tasdig'i:</b> Haqiqatan ham <code>${call.name}</code> bajarilsinmi?`);
      kb.row(btn('⚠️ Tasdiqlayman (Bajarish)', cb(ROUTES.attentionAi, it.id, 't2')))
        .row(btn('🚫 Bekor qilish', cb(ROUTES.attentionIgnore, it.id, 'v')));
    } else {
      kb.row(btn('💬 Reply', cb(ROUTES.attentionReply, it.id, 'v')), btn('🤖 Let AI reply', cb(ROUTES.attentionAi, it.id, 'v')))
        .row(btn('🚫 Ignore', cb(ROUTES.attentionIgnore, it.id, 'v')))
        .row(it.senderTelegramUserId !== null ? btn('👤 Always manual for this user', cb(ROUTES.attentionManual, it.id, 'v')) : null);
    }
  }
  kb.row(
    btn('🔎 Xabar tafsiloti', cb(ROUTES.messageOpen, it.messageId, 'oa', it.id)),
    it.senderTelegramUserId !== null ? btn('👤 Foydalanuvchi', cb('u', it.senderTelegramUserId)) : null,
  ).back(cb('oa.l', 0));
  return { text: lines.join('\n'), keyboard: kb.build() };
}

/**
 * "Let AI reply" pressed on a notification: swap its buttons for a progress marker so the
 * stale actions are not pressed again. (Resolving an item removes the buttons via the
 * attention service → notifier, so other actions need no extra edit.)
 */
async function markNotification(ctx: Context, id: number, outcome: string): Promise<void> {
  if (!ctx.callbackQuery?.message) return;
  const keyboard = new Kb().row(btn(outcome, NOP), btn('🔎 Ochish', cb(ROUTES.attentionOpen, id))).build();
  await ctx.editMessageReplyMarkup({ reply_markup: keyboard }).catch(() => undefined);
}

export function registerAttention(kit: AdminKit): void {
  const { router, deps } = kit;

  /** `v` = pressed inside the item view (re-render it); otherwise it came from a notification. */
  const fromView = (flag: string | undefined) => flag === 'v';

  const showItem = async (ctx: Context, id: number, fresh = false): Promise<boolean> => {
    const item = await deps.attention.get(id);
    if (!item) return false;
    await show(ctx, buildAttentionItem(item, new Date(), deps.timezone), { fresh });
    return true;
  };

  const showList = async (ctx: Context, page: number) => {
    const { items, info } = await loadPage(page, PER_PAGE, (take, skip) => deps.attention.listPending(take, skip));
    await show(ctx, buildAttentionList(items, info, new Date()));
  };

  router.action('oa.l', async (ctx, [page]) => {
    await showList(ctx, pageArg(page));
  });

  router.action(ROUTES.attentionOpen, async (ctx, [raw, flag]) => {
    const id = intId(raw);
    // From a notification (no flag) the item opens as a new message so the notification stays.
    if (id === null || !(await showItem(ctx, id, flag !== 'l'))) return { text: 'Element topilmadi.', alert: true };
  });

  /** `c` = explicit "resend anyway" after a possibly delivered reply (the next text is the confirmation). */
  router.action(ROUTES.attentionReply, async (ctx, [raw, flag]) => {
    const id = intId(raw);
    const item = id === null ? null : await deps.attention.get(id);
    if (!item) return { text: 'Element topilmadi.', alert: true };
    if (item.status !== 'PENDING') return { text: RESOLVED, alert: true };
    // The admin sees the warning before typing, so the typed text itself is the explicit confirmation.
    const warn = flag === 'c' || item.uncertainDelivery === true;
    await ask(
      kit,
      ctx,
      'oa.reply',
      { id: item.id, back: cb(ROUTES.attentionOpen, item.id, 'l'), ...(warn ? { confirmed: 1 } : {}) },
      [
        `💬 <b>${quote(item.userLabel, 80)}</b> ga javobingizni yozing:\n\n«${fit(item.text, 1200)}»`,
        warn ? `${MAY_HAVE_BEEN_DELIVERED} Baribir yubormoqchi bo‘lsangiz, matnni yozing — bu tasdiq hisoblanadi.` : null,
        'Keyingi matnli xabaringiz shu chatga sizning nomingizdan yuboriladi.',
      ]
        .filter((line): line is string => line !== null)
        .join('\n\n'),
      { fresh: !fromView(flag) },
    );
    return '✍️ Javobingizni yozing';
  });

  router.input('oa.reply', async (ctx, text, payload) => {
    const id = typeof payload.id === 'number' ? payload.id : intId(String(payload.id ?? ''));
    const adminId = adminIdOf(kit, ctx);
    const item = id === null ? null : await deps.attention.get(id);
    if (!item || item.status !== 'PENDING') {
      await show(ctx, { text: `${RESOLVED} Javob yuborilmadi.`, keyboard: new Kb().row(btn('🔔 Navbat', cb('oa.l', 0))).back().build() });
      return;
    }
    const confirmed = payload.confirmed === 1;
    const result = confirmed
      ? await deps.pipeline.ownerManualReply(item.id, text, adminId, { confirmed: true })
      : await deps.pipeline.ownerManualReply(item.id, text, adminId);
    if (result === 'sent') {
      await show(ctx, { text: '✅ Javob yuborildi.', keyboard: new Kb().row(btn('🔔 Navbat', cb('oa.l', 0))).back().build() });
    } else if (result === 'resolved') {
      await show(ctx, { text: `${RESOLVED} Javob yuborilmadi.`, keyboard: new Kb().back().build() });
    } else if (result === 'uncertain' || result === 'confirm') {
      // Never offer a one-tap resend: it could duplicate a message the contact already has.
      await show(ctx, {
        text:
          result === 'uncertain'
            ? `⚠️ Javob yetib borgan bo‘lishi mumkin: Telegram natijani tasdiqlamadi. Chatni tekshiring — qayta yuborish faqat tasdiqlaganingizdan keyin.`
            : `${MAY_HAVE_BEEN_DELIVERED} Javobingiz yuborilmadi.`,
        keyboard: new Kb()
          .row(btn('🔁 Baribir qayta yozish (tasdiqlash)', cb(ROUTES.attentionReply, item.id, 'c')))
          .row(btn('🔔 Navbat', cb('oa.l', 0)))
          .back()
          .build(),
      });
    } else {
      await show(ctx, {
        text: '❌ Javobni yuborib bo‘lmadi. Telegram Business ulanishi va botning «javob berish» huquqini tekshiring.',
        keyboard: new Kb().row(btn('🔁 Qayta urinish', cb(ROUTES.attentionReply, item.id))).back().build(),
      });
    }
  });

  router.action(ROUTES.attentionAi, async (ctx, [raw, flag]) => {
    const id = intId(raw);
    const item = id === null ? null : await deps.attention.get(id);
    if (!item) return { text: 'Element topilmadi.', alert: true };
    if (item.status !== 'PENDING') return { text: RESOLVED, alert: true };
    const adminId = adminIdOf(kit, ctx);
    
    if (flag === 't1') {
      // Step 1 approved. Move to Step 2.
      await kit.deps.db.ownerAttention.update({
        where: { id: item.id },
        data: { reason: 'TOOL_APPROVAL_2' }
      });
      await showItem(ctx, item.id);
      return '1-bosqich tasdiqlandi. Ikkinchisini kuting.';
    }
    
    if (flag === 't2') {
      // Step 2 approved. Execute tool.
      setNotice(ctx, '🛠 Tool bajarilmoqda...');
      await showItem(ctx, item.id);
      
      const { executeGithubTool } = await import('../../../plugins/github.js');
      const call = JSON.parse(item.detail || '{}');
      const result = await executeGithubTool(call.name, call.args);
      
      // Store tool result as a synthetic message so AI sees it
      await kit.deps.db.message.create({
        data: {
          chatId: item.chatId,
          direction: 'INCOMING',
          telegramMessageId: 0,
          telegramDate: new Date(),
          type: 'OTHER',
          currentText: `[SYSTEM] Tool ${call.name} execution result: ${result}`,
          status: 'ANSWERED'
        }
      });
      
      // Now enqueue the AI response job which will read history and reply.
      await deps.queue.enqueue(
        'text',
        'attention.ai',
        { attentionId: item.id, adminId: adminId.toString() },
        { dedupeKey: `attention-ai:${item.id}:${Date.now()}` },
      );
      await markNotification(ctx, item.id, '🤖 Tool bajarildi. AI javob tayyorlamoqda…');
      return 'Tool muvaffaqiyatli bajarildi!';
    }
    
    const jobId = await deps.queue.enqueue(
      'text',
      'attention.ai',
      { attentionId: item.id, adminId: adminId.toString() },
      { dedupeKey: `attention-ai:${item.id}` },
    );
    if (fromView(flag)) {
      setNotice(ctx, '🤖 AI javob tayyorlayapti… Natija alohida xabar bilan keladi.');
      await showItem(ctx, item.id);
    } else {
      await markNotification(ctx, item.id, '🤖 AI javob tayyorlanmoqda…');
    }
    return jobId === null ? '🤖 AI javob allaqachon tayyorlanmoqda…' : '🤖 AI javob tayyorlayapti…';
  });

  router.action(ROUTES.attentionIgnore, async (ctx, [raw, flag]) => {
    const id = intId(raw);
    if (id === null) return { text: 'Element topilmadi.', alert: true };
    const done = await deps.attention.resolve(id, 'IGNORED', adminIdOf(kit, ctx));
    if (fromView(flag)) await showItem(ctx, id);
    return done ? '🚫 E’tiborsiz qoldirildi' : { text: RESOLVED, alert: true };
  });

  router.action(ROUTES.attentionManual, async (ctx, [raw, flag]) => {
    const id = intId(raw);
    const item = id === null ? null : await deps.attention.get(id);
    if (!item) return { text: 'Element topilmadi.', alert: true };
    if (item.senderTelegramUserId === null) return { text: 'Bu xabarning yuboruvchisi noma’lum.', alert: true };
    const adminId = adminIdOf(kit, ctx);
    await deps.users.setMode(item.senderTelegramUserId, 'MANUAL', adminId);
    const done = await deps.attention.resolve(item.id, 'IGNORED', adminId);
    if (fromView(flag)) await showItem(ctx, item.id);
    return done ? '👤 Endi bu foydalanuvchiga doim o‘zingiz javob berasiz' : '👤 Rejim: MANUAL (xabar allaqachon hal qilingan)';
  });
}
