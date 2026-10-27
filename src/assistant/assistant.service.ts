import type { PresenceState, UserbotAssistantApi } from '../app/userbot-contract.js';
import type { AiRouter } from '../ai/router/types.js';
import type { ChannelService } from '../channels/channel.service.js';
import type { CalendarService, NewEvent } from '../google/calendar.service.js';
import type { Db } from '../database/client.js';
import type { AssistantTask, AssistantTaskKind } from '../generated/prisma/client.js';
import type { EventLog } from '../logging/events.js';
import { childLogger } from '../logging/logger.js';
import { describeError } from '../logging/sanitize.js';
import type { PgQueue } from '../queues/pg-queue.js';
import type { ContentCipher } from '../security/crypto.js';
import { cb } from '../telegram/admin/callback-data.js';
import { escapeHtml } from '../telegram/common/html.js';
import { formatDateTime, formatTime, startOfDayInTz } from '../utils/time.js';
import { currentTenantOrNull } from '../tenancy/context.js';
import { T } from '../onboarding/texts.js';
import type { DailyService } from '../features/daily.service.js';
import { formatBirthday, normalizeBirthday } from '../features/daily.service.js';
import { fillNotice } from '../features/availability.js';
import type { StyleService } from '../features/style.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { isRateLimitFailure } from '../classifiers/ai-errors.js';
import { parseOwnerIntent, type OwnerIntent } from './intent.js';
import { parseQuickCommand } from './quick.js';
import { PersonResolver, type PersonCandidate } from './resolver.js';

const log = childLogger('assistant');

export const ASSISTANT_ROUTE = 'as';
const DEFAULT_COOLDOWN_MIN = 30;
const DRAFT_TTL_MS = 24 * 3_600_000;
const MAX_ACTIVE_TASKS = 50;
/** How long a pending channel choice / change request waits for the owner. */
const PENDING_TTL_MS = 15 * 60_000;

export interface AssistantButton {
  label: string;
  /** callback_data, always `as|…` and ≤ 64 bytes. */
  data: string;
}

/** What the admin chat shows: HTML text plus optional inline buttons (rows). */
export interface AssistantReply {
  text: string;
  buttons?: AssistantButton[][];
}

/** What the assistant is doing right now (shown live in the admin chat). */
export type AssistantStatus = 'thinking' | 'searching' | 'database' | 'writing' | 'calendar' | 'learning';

/** The admin UI depends only on this. */
export interface AssistantPort {
  handleText(text: string, onStatus?: (status: AssistantStatus) => void): Promise<AssistantReply>;
  handleAction(args: string[]): Promise<AssistantReply>;
}

export interface AssistantDeps {
  db: Db;
  ai: AiRouter;
  cipher: ContentCipher;
  notifier: { text(html: string): Promise<number | undefined> };
  queue: Pick<PgQueue, 'enqueue'>;
  /** Sends text through the owner's account (userbot). */
  sendAsOwner: (chatId: bigint, text: string) => Promise<number>;
  timezone: string;
  /** Channel posts (optional: absent → the assistant says channels are unavailable). */
  channels?: ChannelService;
  /** Google Calendar (super-admin only for now). */
  calendar?: CalendarService;
  /** Daily routines: busy mode, morning summary, birthdays, backups. */
  daily?: DailyService;
  /** Learns the owner's writing style. */
  style?: StyleService;
  settings?: SettingsService;
  events?: Pick<EventLog, 'info' | 'warn'>;
  now?: () => Date;
}

const KIND_LABEL: Record<AssistantTaskKind, string> = {
  WATCH_ONLINE: '🟢 online bo‘lsa xabar berish',
  WATCH_MESSAGE: '✉️ yozsa darhol aytish',
  REMINDER: '⏰ eslatma',
  SEND_MESSAGE: '📤 xabar yuborish',
};

const HELP = [
  '🧑‍💼 <b>Shaxsiy assistent</b> — menga oddiy tilda yozing:',
  '• <i>Firdavs online bo‘lsa menga xabar ber</i> (har safar uchun: <i>har safar</i> deng)',
  '• <i>Ali yozsa darhol ayt</i>',
  '• <i>Soat 18:00 da onamga qo‘ng‘iroq qilishni eslat</i>',
  '• <i>Firdavsga yoz: ertaga 10 da uchrashamiz</i> (yuborishdan oldin tasdiqlaysiz)',
  '• <i>Vazifalarim</i> yoki /tasks · <i>Firdavs kuzatuvini o‘chir</i>',
  '• <i>Kanalga post yoz: yangi xizmatimiz haqida</i> (joylashdan oldin tasdiqlaysiz) · <i>Kanallarim</i>',
  '• <i>Bugun nima rejalarim bor?</i> · <i>Ertaga 15:00 ga Ali bilan uchrashuv qo‘sh</i> (Google Calendar)',
  '• <i>2 soat uchrashuvdaman</i> — «bandman» rejimi · <i>bo‘shadim</i> — o‘chirish',
  '• <i>Ish vaqtim 9 dan 18 gacha</i> · <i>Uslubimni o‘rgan</i>',
  '• <i>Alining tug‘ilgan kuni 12-mart</i> · <i>Tug‘ilgan kunlar</i>',
  '• <i>Bugungi xulosa</i> · <i>Zaxira nusxa ol</i>',
].join('\n');

/**
 * The owner's personal assistant: free-text commands from the admin chat become tasks
 * (presence watches, message watches, reminders, messages sent on the owner's behalf after ✅).
 * Only the owner can reach this (the admin guard runs first); contacts never trigger actions.
 */
export class OwnerAssistant implements AssistantPort {
  /** Per workspace: a draft waiting for the owner's change request (after ✏️), or a post waiting for a channel choice. */
  private readonly pendingRevision = new Map<number, { postId: number; at: number }>();
  private readonly pendingChannel = new Map<number, { instructions: string; exact: boolean; at: number }>();
  private readonly pendingEvent = new Map<number, { event: NewEvent; at: number }>();

  /** Resolves the userbot of the workspace being served (one MTProto account per workspace). */
  private userbotOf: () => UserbotAssistantApi | null = () => null;
  private readonly resolver: PersonResolver;

  constructor(private readonly d: AssistantDeps) {
    this.resolver = new PersonResolver(d.db, () => this.userbot);
  }

  private get userbot(): UserbotAssistantApi | null {
    return this.userbotOf();
  }

  /** The current workspace's userbot helpers (null when not logged in). */
  userbotApi(): UserbotAssistantApi | null {
    return this.userbot;
  }

  attachUserbot(api: UserbotAssistantApi | null | (() => UserbotAssistantApi | null)): void {
    this.userbotOf = typeof api === 'function' ? api : () => api;
  }

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  // ── admin chat entry points ────────────────────────────────────────────

  async handleText(text: string, onStatus: (status: AssistantStatus) => void = () => undefined): Promise<AssistantReply> {
    // A bare id / @username: show what the owner's own workspace knows about that contact (no AI call).
    const lookup = /^\s*(@[A-Za-z][A-Za-z0-9_]{3,31}|\d{5,20})\s*$/.exec(text);
    if (lookup) {
      onStatus('database');
      return this.contactCard(lookup[1]!);
    }
    // After ✏️ on a channel draft, the next message is the change request.
    const tenantKey = currentTenantOrNull()?.tenantId ?? 0;
    const revision = this.pendingRevision.get(tenantKey);
    if (revision && this.d.channels && Date.now() - revision.at < PENDING_TTL_MS) {
      this.pendingRevision.delete(tenantKey);
      onStatus('writing');
      return this.d.channels.revise(revision.postId, text);
    }
    onStatus('thinking');
    // Timers and greetings need no AI (instant, and they work when the AI quota is used up).
    let intent: OwnerIntent | null = parseQuickCommand(text, this.now());
    if (!intent) {
      try {
        intent = await parseOwnerIntent(this.d.ai, text, this.now(), this.d.timezone);
      } catch (error) {
        log.warn({ error: describeError(error) }, 'could not parse the owner command');
        return { text: aiDownText(error) };
      }
    }
    switch (intent.action) {
      case 'list_tasks':
        return this.list();
      case 'cancel_task':
        return this.cancel(intent);
      case 'remind':
        return this.remind(intent);
      case 'watch_online':
      case 'watch_message':
      case 'send_message':
        onStatus('database');
        return this.personTask(intent);
      case 'list_channels':
        return this.d.channels ? this.d.channels.listReply() : { text: '📢 Kanallar bu yerda yoqilmagan.' };
      case 'channel_post':
        return this.channelPost(intent.text ?? text, intent.exact, intent.channel, onStatus, intent.needsSearch);
      case 'calendar_connect':
      case 'calendar_disconnect':
      case 'calendar_list':
      case 'calendar_add':
        return this.calendarCommand(intent, onStatus);
      case 'busy_set':
      case 'busy_clear':
      case 'work_hours':
        return this.availabilityCommand(intent);
      case 'learn_style':
        onStatus('learning');
        return this.learnStyle();
      case 'birthday_set':
        onStatus('database');
        return this.birthdaySet(intent);
      case 'birthdays_list':
        onStatus('database');
        return this.birthdaysList();
      case 'morning_summary':
        if (!this.d.daily) return { text: HELP };
        onStatus('calendar');
        return this.d.daily.morningSummaryText();
      case 'backup_now':
        if (!this.d.daily) return { text: HELP };
        onStatus('database');
        return { text: await this.d.daily.sendBackup() };
      case 'help':
        return { text: HELP };
      default:
        if (intent.needsSearch && this.canSearch()) {
          onStatus('searching');
          const searched = await this.searchAnswer(text);
          if (searched) return searched;
        }
        // chat / unknown: the AI's own answer (help only when it had nothing to say).
        return { text: intent.reply ? escapeHtml(intent.reply) : HELP };
    }
  }

  private async channelPost(
    instructions: string,
    exact: boolean,
    channelQuery: string | undefined,
    onStatus: (status: AssistantStatus) => void,
    needsSearch = false,
  ): Promise<AssistantReply> {
    const channels = this.d.channels;
    if (!channels) return { text: '📢 Kanallar bu yerda yoqilmagan.' };
    const { channel, choices } = await channels.resolve(channelQuery);
    if (!channel) {
      if (choices.length === 0) return { text: channels.howToConnect() };
      this.pendingChannel.set(currentTenantOrNull()?.tenantId ?? 0, { instructions, exact, at: Date.now() });
      return {
        text: '📢 Qaysi kanalga?',
        buttons: [...choices.map((c) => [{ label: c.title.slice(0, 40), data: cb(ASSISTANT_ROUTE, 'cp', 'pick', c.id) }]), [{ label: '❌ Bekor', data: cb(ASSISTANT_ROUTE, 'cp', 'drop', 0) }]],
      };
    }
    const search = needsSearch && !exact && this.canSearch();
    if (!exact) onStatus(search ? 'searching' : 'writing');
    if (search) {
      try {
        return await channels.draft(channel, instructions, exact, { webSearch: true });
      } catch (error) {
        // Usually a free Gemini key without search quota: write the post without search instead.
        this.searchBlockedUntil = Date.now() + 6 * 3_600_000;
        log.warn({ error: describeError(error) }, 'channel draft with web search failed; writing without search');
        onStatus('writing');
      }
    }
    try {
      const reply = await channels.draft(channel, instructions, exact, { offline: needsSearch && !exact });
      if (needsSearch && !exact)
        reply.text +=
          '\n\n⚠️ <i>Google qidiruvi hozir ishlamadi (Gemini kalitida billing yo‘q), shuning uchun post umumiy bilim asosida yozildi — so‘nggi yangilik, sana va raqamlarni joylashdan oldin tekshiring.</i>';
      return reply;
    } catch (error) {
      log.warn({ error: describeError(error) }, 'channel draft failed');
      return { text: '❌ AI hozir javob bermadi (Gemini limiti yoki sekinlik). Birozdan keyin qaytadan yozing yoki 📜 /logs ni ko‘ring.' };
    }
  }

  /** Busy mode on/off and working hours. */
  private async availabilityCommand(intent: OwnerIntent): Promise<AssistantReply> {
    const daily = this.d.daily;
    const settings = this.d.settings;
    if (!daily || !settings) return { text: HELP };
    const tz = this.d.timezone;
    if (intent.action === 'busy_clear')
      return { text: (await daily.clearBusy()) ? '🟢 «Bandman» rejimi o‘chirildi.' : 'ℹ️ «Bandman» rejimi yoqilmagan edi.' };
    if (intent.action === 'work_hours') {
      if (!intent.startAt || !intent.endAt) return { text: '🕘 Ish vaqtini aniq yozing, masalan: <i>ish vaqtim 9:00 dan 18:00 gacha</i>.' };
      const start = formatTime(intent.startAt, tz);
      const end = formatTime(intent.endAt, tz);
      await settings.set('workStart', start);
      await settings.set('workEnd', end);
      await settings.set('workHoursEnabled', true);
      return {
        text: `🕘 Ish vaqti: <b>${start}–${end}</b> (yoqildi). Undan tashqari mijozlarga «${escapeHtml(start)} dan keyin javob beraman» degan xabar boradi.\nDam olish kunlari va rejimni menyuda o‘zgartirasiz: /menu → ✨ Yordamchi.`,
      };
    }
    const now = this.now();
    let until = intent.endAt ?? new Date(now.getTime() + 3_600_000);
    if (until.getTime() <= now.getTime()) return { text: '⏳ Qachongacha bandsiz? Masalan: <i>2 soat uchrashuvdaman</i> yoki <i>17:00 gacha bandman</i>.' };
    if (until.getTime() > now.getTime() + 7 * 86_400_000) until = new Date(now.getTime() + 7 * 86_400_000);
    const note = (intent.text ?? '').slice(0, 60);
    await daily.setBusy(until, note);
    const s = await settings.get();
    const preview = fillNotice(s.busyReplyText, { owner: s.ownerName, note, until, timezone: tz });
    return {
      text: `⏳ <b>«Bandman» rejimi ${formatTime(until, tz)} gacha</b>${note ? ` (${escapeHtml(note)})` : ''}.\n\nShaxsiy savollarga mijozlarga shunday javob boradi:\n«${escapeHtml(preview)}»\nOddiy savollarga AI odatdagidek javob beradi.`,
      buttons: [[{ label: '🟢 Bo‘shadim (o‘chirish)', data: cb(ASSISTANT_ROUTE, 'busy', 'off') }]],
    };
  }

  private async learnStyle(): Promise<AssistantReply> {
    if (!this.d.style) return { text: HELP };
    const result = await this.d.style.learn();
    if (result.ok)
      return { text: `✍️ <b>Uslubingizni o‘rgandim</b> (${result.messages} ta xabaringizdan). Endi AI shunday yozadi:\n\n${escapeHtml(result.profile)}\n\n<i>Har hafta avtomatik yangilanadi. O‘chirish: /menu → ✨ Yordamchi.</i>` };
    if (result.reason === 'too_few')
      return { text: `✍️ Uslubni o‘rganish uchun kamida 20 ta o‘zingiz yozgan xabar kerak (hozir ${result.messages} ta). Chatlarda yozishda davom eting — keyin avtomatik o‘rganaman.` };
    return { text: '❌ AI hozir javob bermadi. Birozdan keyin qaytadan urinib ko‘ring.' };
  }

  private async birthdaySet(intent: OwnerIntent): Promise<AssistantReply> {
    if (!this.d.daily) return { text: HELP };
    if (!intent.person) return { text: '🎂 Kimning tug‘ilgan kuni? Masalan: <i>Alining tug‘ilgan kuni 12-mart</i>.' };
    if (!intent.startAt) return { text: `🎂 ${escapeHtml(intent.person)}ning tug‘ilgan kuni qachon? Masalan: <i>12-mart</i>.` };
    const found = await this.resolver.resolve(intent.person);
    if (found.status === 'none') return { text: `🔎 «${escapeHtml(intent.person)}» ni topa olmadim. Uning @username ini yoki Telegram ID sini yozing.` };
    if (found.status === 'many')
      return { text: `👥 «${escapeHtml(intent.person)}» bir nechta: ${found.candidates.map((c) => escapeHtml(c.label)).join(', ')}. @username bilan aniqroq yozing.` };
    const withYear = /\b(19|20)\d{2}\b/.test(intent.text ?? '');
    const birthday = normalizeBirthday(intent.startAt, withYear, this.d.timezone);
    let user = await this.d.db.telegramUser.findFirst({ where: { telegramUserId: found.person.telegramUserId } });
    user ??= await this.d.db.telegramUser.create({ data: { telegramUserId: found.person.telegramUserId, firstName: found.person.label.slice(0, 64) } });
    await this.d.daily.setBirthday(user.id, birthday);
    return { text: `🎂 Saqladim: <b>${escapeHtml(found.person.label)}</b> — ${formatBirthday(birthday)}. O‘sha kuni ertalab eslataman va tabrik variantini tayyorlab beraman.` };
  }

  private async birthdaysList(): Promise<AssistantReply> {
    const daily = this.d.daily;
    if (!daily) return { text: HELP };
    await daily.syncTelegramBirthdays().catch((error: unknown) => log.debug({ error: describeError(error) }, 'birthday sync failed'));
    const upcoming = await daily.upcomingBirthdays(30);
    if (upcoming.length === 0)
      return { text: '🎂 Keyingi 30 kunda tug‘ilgan kun yo‘q (yoki hali bilmayman).\nQo‘shish: <i>Alining tug‘ilgan kuni 12-mart</i>. Userbot ulangan bo‘lsa, Telegram’dagi kontaktlaringiz tug‘ilgan kunlarini o‘zim olaman.' };
    const lines = ['🎂 <b>Yaqin tug‘ilgan kunlar (30 kun)</b>', ''];
    for (const u of upcoming.slice(0, 30)) {
      const name = escapeHtml(labelOf(u.user));
      lines.push(`• ${formatBirthday(u.date)} — ${name}${u.inDays === 0 ? ' — <b>bugun!</b>' : u.inDays === 1 ? ' — ertaga' : ` — ${u.inDays} kundan keyin`}`);
    }
    return { text: lines.join('\n') };
  }

  private async calendarCommand(intent: OwnerIntent, onStatus: (status: AssistantStatus) => void): Promise<AssistantReply> {
    const calendar = this.d.calendar;
    if (!calendar || !calendar.allowed()) return { text: '📅 Google Calendar hozircha faqat administrator uchun.' };
    if (!calendar.configured())
      return { text: '📅 Google Calendar sozlanmagan: Render’da <code>GOOGLE_CLIENT_ID</code> va <code>GOOGLE_CLIENT_SECRET</code> qo‘shilishi kerak.' };
    if (intent.action === 'calendar_connect')
      return { text: `📅 Google Calendar’ni ulash uchun bosing: <a href="${escapeHtml(calendar.connectUrl())}">🔗 Google bilan ulash</a>\n\n<i>Havola 15 daqiqa amal qiladi. Google «tasdiqlanmagan ilova» desa: Advanced → Go to …</i>` };
    if (intent.action === 'calendar_disconnect') return { text: (await calendar.disconnect()) ? '📅 Google Calendar uzildi.' : '📅 Kalendar ulanmagan edi.' };
    if (!(await calendar.account())) return { text: '📅 Kalendar hali ulanmagan. <i>Kalendarni ula</i> deb yozing.' };
    const tz = this.d.timezone;
    try {
      if (intent.action === 'calendar_list') {
        onStatus('calendar');
        const from = intent.startAt ?? startOfDayInTz(this.now(), tz);
        const to = intent.endAt && intent.endAt > from ? intent.endAt : new Date(from.getTime() + 24 * 3_600_000 - 1);
        const events = await calendar.listEvents(from, to);
        return { text: calendar.formatEvents(events, `Rejalar: ${formatDateTime(from, tz)} — ${formatDateTime(to, tz)}`) };
      }
      if (!intent.startAt) return { text: '📅 Qachonga qo‘shay? Masalan: <i>ertaga 15:00 ga Ali bilan uchrashuv qo‘sh</i>.' };
      const start = intent.startAt;
      const end = intent.endAt && intent.endAt > start ? intent.endAt : new Date(start.getTime() + 3_600_000);
      const event: NewEvent = { summary: (intent.text ?? 'Uchrashuv').slice(0, 200), start, end };
      this.pendingEvent.set(currentTenantOrNull()?.tenantId ?? 0, { event, at: Date.now() });
      return {
        text: `📅 Kalendarga qo‘shaymi?\n\n<b>${escapeHtml(event.summary)}</b>\n${formatDateTime(start, tz)} — ${formatDateTime(end, tz)}`,
        buttons: [[{ label: '✅ Qo‘shish', data: cb(ASSISTANT_ROUTE, 'cal', 'ok', 0) }, { label: '❌ Bekor', data: cb(ASSISTANT_ROUTE, 'cal', 'no', 0) }]],
      };
    } catch (error) {
      log.warn({ error: describeError(error) }, 'calendar command failed');
      return { text: '❌ Google Calendar bilan bog‘lanib bo‘lmadi. Kalendarni qayta ulab ko‘ring (<i>kalendarni ula</i>).' };
    }
  }

  private async calendarAction(verb: string | undefined): Promise<AssistantReply> {
    const key = currentTenantOrNull()?.tenantId ?? 0;
    const pending = this.pendingEvent.get(key);
    this.pendingEvent.delete(key);
    if (verb !== 'ok') return { text: '❌ Bekor qilindi.' };
    if (!pending || Date.now() - pending.at > PENDING_TTL_MS || !this.d.calendar?.allowed()) return { text: 'ℹ️ Bu so‘rov eskirgan. Qaytadan yozing.' };
    try {
      const created = await this.d.calendar.createEvent(pending.event);
      return { text: `✅ Kalendarga qo‘shildi: <b>${escapeHtml(created.summary)}</b>\n${formatDateTime(created.start, this.d.timezone)}` };
    } catch (error) {
      log.warn({ error: describeError(error) }, 'calendar event creation failed');
      return { text: '❌ Tadbirni qo‘shib bo‘lmadi. Qaytadan urinib ko‘ring.' };
    }
  }

  private async channelAction(verb: string | undefined, id: number): Promise<AssistantReply> {
    const channels = this.d.channels;
    if (!channels || !Number.isInteger(id)) return { text: 'ℹ️ Bu tugma eskirgan.' };
    const tenantKey = currentTenantOrNull()?.tenantId ?? 0;
    switch (verb) {
      case 'ok':
        return channels.publish(id);
      case 're':
        return channels.regenerate(id);
      case 'no':
        return channels.cancel(id);
      case 'ed':
        if (!(await channels.isDraft(id))) return { text: 'ℹ️ Bu post loyihasi eskirgan.' };
        this.pendingRevision.set(tenantKey, { postId: id, at: Date.now() });
        return { text: '✏️ Qanday o‘zgartiray? Yozing, masalan: <i>qisqaroq qil</i>, <i>oxiriga narxni qo‘sh</i>, <i>rasmiyroq ohangda</i>.' };
      case 'pick': {
        const pending = this.pendingChannel.get(tenantKey);
        this.pendingChannel.delete(tenantKey);
        if (!pending || Date.now() - pending.at > PENDING_TTL_MS) return { text: 'ℹ️ Bu so‘rov eskirgan. Qaytadan yozing.' };
        const channel = (await channels.list()).find((c) => c.id === id && c.canPost);
        if (!channel) return { text: 'ℹ️ Bu kanal endi ulanmagan.' };
        return channels.draft(channel, pending.instructions, pending.exact);
      }
      case 'drop':
        this.pendingChannel.delete(tenantKey);
        return { text: '❌ Bekor qilindi.' };
      default:
        return { text: 'ℹ️ Bu tugma eskirgan.' };
    }
  }

  /** Web search is skipped until then after the provider refused it (e.g. no search quota on a free key). */
  private searchBlockedUntil = 0;

  /** Answers with Google Search grounding (Gemini) and lists the sources; null when it fails. */
  private async searchAnswer(question: string): Promise<AssistantReply | null> {
    if (Date.now() < this.searchBlockedUntil) return null;
    try {
      const routed = await this.d.ai.generateReply({
        system: [
          "You are the owner's personal assistant. Answer the question using Google Search for current facts.",
          'Be accurate and concise (1–6 sentences unless more is asked), in the language of the question, plain text without markdown.',
          `Current time: ${formatDateTime(this.now(), this.d.timezone)} (${this.d.timezone}).`,
        ].join('\n'),
        messages: [{ role: 'user', parts: [{ type: 'text', text: question.slice(0, 2000) }] }],
        maxOutputTokens: 1200,
        temperature: 0.3,
        webSearch: true,
        timeoutMs: 45_000,
      });
      const answer = routed.result.text.trim();
      if (!answer) return null;
      const sources = (routed.result.sources ?? []).slice(0, 3);
      const list = sources.map((s, i) => `${i + 1}. <a href="${escapeHtml(s.url)}">${escapeHtml((s.title ?? s.url).slice(0, 60))}</a>`);
      return { text: escapeHtml(answer) + (list.length ? `\n\n🔗 Manbalar:\n${list.join('\n')}` : '') };
    } catch (error) {
      const message = describeError(error);
      // Quota / not allowed: don't keep paying the extra round trip on every question.
      if (/429|quota|RESOURCE_EXHAUSTED|PERMISSION_DENIED|not supported/i.test(message)) this.searchBlockedUntil = Date.now() + 6 * 3_600_000;
      log.warn({ error: message }, 'web search answer failed; using the direct answer');
      return null;
    }
  }

  /** True while web search is available (the live status only shows "searching" then). */
  canSearch(): boolean {
    return Date.now() >= this.searchBlockedUntil;
  }

  /**
   * What this workspace already knows about a contact who wrote to the owner (by id or @username).
   * Only stored data of the owner's own conversations is shown: no lookup of strangers on Telegram.
   */
  private async contactCard(query: string): Promise<AssistantReply> {
    const user = query.startsWith('@')
      ? await this.d.db.telegramUser.findFirst({ where: { username: { equals: query.slice(1), mode: 'insensitive' } } })
      : await this.d.db.telegramUser.findFirst({ where: { telegramUserId: BigInt(query) } });
    if (!user)
      return { text: `🔎 <code>${escapeHtml(query)}</code> sizga yozganlar orasida topilmadi. Men faqat siz bilan yozishgan odamlar haqidagi ma’lumotni ko‘rsataman.` };
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || '—';
    const rule = await this.d.db.userRule.findFirst({ where: { matchType: 'USER_ID', matchValue: user.telegramUserId.toString() } });
    const tz = this.d.timezone;
    const lines = [
      `👤 <b>${escapeHtml(name)}</b>`,
      `Username: ${user.username ? `@${escapeHtml(user.username)}` : '—'}`,
      `ID: <code>${user.telegramUserId}</code>`,
      `Kontaktlaringizda: ${user.isContact ? 'ha' : 'yo‘q'}${user.isBot ? ' · 🤖 bot' : ''}`,
      `Xabarlar: ${user.messageCount} · birinchi: ${formatDateTime(user.firstSeenAt, tz)}${user.lastMessageAt ? ` · oxirgi: ${formatDateTime(user.lastMessageAt, tz)}` : ''}`,
      `Javob rejimi: ${rule?.mode ?? 'umumiy qoida'}${user.tags.length ? ` · teglar: ${user.tags.map((t) => escapeHtml(t)).join(', ')}` : ''}`,
    ];
    if (user.notes) lines.push(`Izoh: ${escapeHtml(user.notes)}`);
    return { text: lines.join('\n') };
  }

  async handleAction(args: string[]): Promise<AssistantReply> {
    const [verb, a, b] = args;
    if (verb === 'cp') return this.channelAction(a, Number(b));
    if (verb === 'cal') return this.calendarAction(a);
    if (verb === 'busy') return { text: (await this.d.daily?.clearBusy()) ? '🟢 «Bandman» rejimi o‘chirildi.' : 'ℹ️ «Bandman» rejimi yoqilmagan edi.' };
    if (verb === 'bd') {
      const userId = Number(a);
      const user = Number.isInteger(userId) ? await this.d.db.telegramUser.findUnique({ where: { id: userId } }) : null;
      if (!user || !this.d.daily) return { text: 'ℹ️ Bu tugma eskirgan.' };
      return this.d.daily.greetingReply(user);
    }
    const id = Number(a);
    switch (verb) {
      case 'list':
        return this.list();
      case 'del':
        if (Number.isInteger(id)) await this.d.db.assistantTask.updateMany({ where: { id, active: true }, data: { active: false } });
        return this.list('✅ Vazifa o‘chirildi.');
      case 'pick': {
        if (!Number.isInteger(id) || !b || !/^\d{1,20}$/.test(b)) return { text: 'ℹ️ Bu tanlov eskirgan.' };
        const draft = await this.d.db.assistantTask.findUnique({ where: { id } });
        if (!draft || draft.active || draft.confirmed || draft.targetTelegramUserId !== null) return { text: 'ℹ️ Bu tanlov eskirgan.' };
        const user = await this.d.db.telegramUser.findFirst({ where: { telegramUserId: BigInt(b) } });
        const person: PersonCandidate = { telegramUserId: BigInt(b), label: user ? labelOf(user) : `id ${b}` };
        await this.d.db.assistantTask.delete({ where: { id } });
        return this.createForPerson(draft.kind, person, draft.repeat, this.d.cipher.decrypt(draft.text) ?? undefined);
      }
      case 'send':
        return this.confirmSend(id);
      case 'no':
        if (Number.isInteger(id)) await this.d.db.assistantTask.deleteMany({ where: { id, confirmed: false, active: false } });
        return { text: '❌ Bekor qilindi.' };
      default:
        return { text: HELP };
    }
  }

  // ── commands ───────────────────────────────────────────────────────────

  private async list(prefix?: string): Promise<AssistantReply> {
    const tasks = await this.d.db.assistantTask.findMany({ where: { active: true }, orderBy: { id: 'asc' }, take: MAX_ACTIVE_TASKS });
    const lines = [prefix, '🧑‍💼 <b>Faol vazifalar</b>'].filter(Boolean) as string[];
    if (tasks.length === 0) lines.push('', 'Hozircha vazifa yo‘q.', '', HELP);
    const buttons: AssistantButton[][] = [];
    for (const t of tasks) {
      lines.push(`${t.id}. ${this.describe(t)}`);
      buttons.push([{ label: `❌ ${t.id}-vazifani o‘chirish`, data: cb(ASSISTANT_ROUTE, 'del', t.id) }]);
    }
    return { text: lines.join('\n'), ...(buttons.length ? { buttons } : {}) };
  }

  private describe(t: AssistantTask): string {
    const who = t.targetLabel ? `<b>${escapeHtml(t.targetLabel)}</b> — ` : '';
    if (t.kind === 'REMINDER') {
      const when = t.runAt ? formatDateTime(t.runAt, this.d.timezone) : '?';
      return `⏰ ${when}: ${escapeHtml(this.d.cipher.decrypt(t.text) ?? '')}`;
    }
    return `${who}${KIND_LABEL[t.kind]}${t.repeat ? ' (har safar)' : ' (bir marta)'}`;
  }

  private async cancel(intent: OwnerIntent): Promise<AssistantReply> {
    if (intent.taskId) {
      const r = await this.d.db.assistantTask.updateMany({ where: { id: intent.taskId, active: true }, data: { active: false } });
      return this.list(r.count ? `✅ ${intent.taskId}-vazifa o‘chirildi.` : `ℹ️ ${intent.taskId}-vazifa topilmadi.`);
    }
    if (intent.person) {
      const found = await this.resolver.resolve(intent.person);
      const ids = found.status === 'one' ? [found.person.telegramUserId] : found.status === 'many' ? found.candidates.map((c) => c.telegramUserId) : [];
      const r = ids.length
        ? await this.d.db.assistantTask.updateMany({ where: { active: true, targetTelegramUserId: { in: ids } }, data: { active: false } })
        : { count: 0 };
      return this.list(r.count ? `✅ ${r.count} ta vazifa o‘chirildi.` : `ℹ️ «${escapeHtml(intent.person)}» bo‘yicha faol vazifa topilmadi.`);
    }
    return this.list('Qaysi vazifani o‘chiray? Raqamini yozing yoki pastdagi tugmani bosing.');
  }

  private async remind(intent: OwnerIntent): Promise<AssistantReply> {
    if (!intent.remindAt) return { text: '⏰ Qachon eslatay? Vaqtni aniq yozing, masalan: <i>soat 18:30 da …</i> yoki <i>2 soatdan keyin …</i>' };
    if (!(await this.hasRoom())) return { text: `⚠️ Faol vazifalar juda ko‘p (${MAX_ACTIVE_TASKS}). Avval keraksizlarini o‘chiring: /tasks` };
    const note = intent.text ?? 'Eslatma';
    const task = await this.d.db.assistantTask.create({
      data: { kind: 'REMINDER', text: this.d.cipher.encrypt(note), runAt: intent.remindAt, active: true, confirmed: true },
    });
    await this.d.queue.enqueue('text', 'assistant.remind', { taskId: task.id }, { runAt: intent.remindAt, dedupeKey: `assistant-remind:${task.id}`, maxAttempts: 3 });
    return { text: `⏰ ${formatDateTime(intent.remindAt, this.d.timezone)} da eslataman: ${escapeHtml(note)}` };
  }

  private async personTask(intent: OwnerIntent): Promise<AssistantReply> {
    const kind: AssistantTaskKind =
      intent.action === 'watch_online' ? 'WATCH_ONLINE' : intent.action === 'watch_message' ? 'WATCH_MESSAGE' : 'SEND_MESSAGE';
    if (!intent.person) return { text: `👤 Kim haqida gap ketyapti? Ismini yoki @username ni yozing.${intent.reply ? `\n${escapeHtml(intent.reply)}` : ''}` };
    if (kind === 'SEND_MESSAGE' && !intent.text) return { text: `📤 ${escapeHtml(intent.person)} ga nima deb yozay? Masalan: <i>${escapeHtml(intent.person)}ga yoz: salom</i>` };
    if ((kind === 'WATCH_ONLINE' || kind === 'SEND_MESSAGE') && !this.userbot?.isReady())
      return { text: T[currentTenantOrNull()?.language ?? 'uz'].userbotOnly };
    if (!(await this.hasRoom())) return { text: `⚠️ Faol vazifalar juda ko‘p (${MAX_ACTIVE_TASKS}). Avval keraksizlarini o‘chiring: /tasks` };

    const found = await this.resolver.resolve(intent.person);
    if (found.status === 'none')
      return { text: `🔎 «${escapeHtml(intent.person)}» ni topa olmadim. Uning @username ini yoki Telegram ID sini yozing.` };
    if (found.status === 'many') {
      const draft = await this.d.db.assistantTask.create({
        data: { kind, repeat: intent.repeat, text: this.d.cipher.encrypt(intent.text ?? null), active: false, confirmed: false },
      });
      return {
        text: `👥 «${escapeHtml(intent.person)}» bir nechta. Qaysi biri?`,
        buttons: [
          ...found.candidates.map((c) => [{ label: c.label.slice(0, 40), data: cb(ASSISTANT_ROUTE, 'pick', draft.id, c.telegramUserId) }]),
          [{ label: '❌ Bekor qilish', data: cb(ASSISTANT_ROUTE, 'no', draft.id) }],
        ],
      };
    }
    return this.createForPerson(kind, found.person, intent.repeat, intent.text);
  }

  private async createForPerson(kind: AssistantTaskKind, person: PersonCandidate, repeat: boolean, text?: string): Promise<AssistantReply> {
    const who = `<b>${escapeHtml(person.label)}</b>`;
    if (kind === 'SEND_MESSAGE') {
      if (!text) return { text: `📤 ${who} ga nima deb yozay?` };
      const draft = await this.d.db.assistantTask.create({
        data: { kind, targetTelegramUserId: person.telegramUserId, targetLabel: person.label, text: this.d.cipher.encrypt(text), active: false, confirmed: false },
      });
      return {
        text: `📤 ${who} ga sizning nomingizdan shu xabar yuborilsinmi?\n\n«${escapeHtml(text)}»`,
        buttons: [[
          { label: '✅ Yuborish', data: cb(ASSISTANT_ROUTE, 'send', draft.id) },
          { label: '❌ Bekor qilish', data: cb(ASSISTANT_ROUTE, 'no', draft.id) },
        ]],
      };
    }

    const task = await this.d.db.assistantTask.create({
      data: { kind, targetTelegramUserId: person.telegramUserId, targetLabel: person.label, repeat, cooldownMinutes: DEFAULT_COOLDOWN_MIN, active: true, confirmed: true },
    });
    const how = repeat ? 'har safar' : 'bir marta';
    if (kind === 'WATCH_MESSAGE') return { text: `✉️ ${who} yozishi bilan darhol xabar beraman (${how}).` };

    // WATCH_ONLINE: check the current presence once, so "already online" is reported right away.
    let extra = '';
    try {
      const user = await this.d.db.telegramUser.findFirst({ where: { telegramUserId: person.telegramUserId } });
      const states = (await this.userbot?.presence([{ id: person.telegramUserId, accessHash: user?.accessHash ?? null }])) ?? new Map<bigint, PresenceState>();
      const state = states.get(person.telegramUserId);
      if (state) await this.d.db.assistantTask.update({ where: { id: task.id }, data: { lastPresence: state } });
      if (state === 'online') extra = '\n🟢 U hozir ham online.';
      else if (state === 'recently' || state === 'hidden')
        extra = '\n⚠️ Uning «last seen» sozlamasi yashirilgan bo‘lishi mumkin — unda Telegram online holatini ko‘rsatmaydi va xabar bera olmayman.';
    } catch (error) {
      log.debug({ error: describeError(error) }, 'initial presence check failed');
    }
    return { text: `👀 ${who} Telegram’ga kirishi (online bo‘lishi) bilan xabar beraman (${how}).${extra}`, buttons: [[{ label: '📋 Vazifalar', data: cb(ASSISTANT_ROUTE, 'list') }]] };
  }

  private async confirmSend(id: number): Promise<AssistantReply> {
    if (!Number.isInteger(id)) return { text: 'ℹ️ Bu so‘rov eskirgan.' };
    // Claim the draft first so a double click can never send twice.
    const claimed = await this.d.db.assistantTask.updateMany({ where: { id, kind: 'SEND_MESSAGE', confirmed: false, active: false }, data: { confirmed: true } });
    if (claimed.count === 0) return { text: 'ℹ️ Bu xabar allaqachon yuborilgan yoki bekor qilingan.' };
    const task = await this.d.db.assistantTask.findUniqueOrThrow({ where: { id } });
    const text = this.d.cipher.decrypt(task.text) ?? '';
    if (!task.targetTelegramUserId || !text) return { text: 'ℹ️ Bu so‘rov eskirgan.' };
    try {
      await this.d.sendAsOwner(task.targetTelegramUserId, text);
      await this.d.db.assistantTask.update({ where: { id }, data: { triggerCount: 1, lastTriggeredAt: this.now() } });
      return { text: `✅ <b>${escapeHtml(task.targetLabel ?? '')}</b> ga yuborildi:\n«${escapeHtml(text)}»` };
    } catch (error) {
      await this.d.events?.warn('assistant', `send on behalf failed: ${describeError(error)}`);
      return { text: `❌ Yuborib bo‘lmadi: ${escapeHtml(describeError(error, 200))}` };
    }
  }

  private async hasRoom(): Promise<boolean> {
    return (await this.d.db.assistantTask.count({ where: { active: true } })) < MAX_ACTIVE_TASKS;
  }

  // ── triggers ───────────────────────────────────────────────────────────

  /** Presence change (push or poll). Notifies only on a transition to online, respecting cooldowns. */
  async onPresence(userId: bigint, state: PresenceState): Promise<void> {
    const tasks = await this.d.db.assistantTask.findMany({ where: { active: true, kind: 'WATCH_ONLINE', targetTelegramUserId: userId } });
    const now = this.now();
    for (const task of tasks) {
      const becameOnline = state === 'online' && task.lastPresence !== 'online';
      const coolingDown = task.lastTriggeredAt !== null && now.getTime() - task.lastTriggeredAt.getTime() < task.cooldownMinutes * 60_000;
      if (!becameOnline || (task.repeat && coolingDown)) {
        if (task.lastPresence !== state) await this.d.db.assistantTask.update({ where: { id: task.id }, data: { lastPresence: state } });
        continue;
      }
      // Claim the trigger (another process may see the same presence update).
      const claimed = await this.d.db.assistantTask.updateMany({
        where: { id: task.id, active: true, OR: [{ lastPresence: null }, { lastPresence: { not: 'online' } }] },
        data: { lastPresence: 'online', lastTriggeredAt: now, triggerCount: { increment: 1 }, ...(task.repeat ? {} : { active: false }) },
      });
      if (claimed.count === 0) continue;
      await this.d.notifier.text(`🟢 <b>${escapeHtml(task.targetLabel ?? `id ${userId}`)}</b> hozir Telegram’da (online).${task.repeat ? '' : '\n<i>Kuzatuv tugadi.</i>'}`);
    }
  }

  /** Called for every stored incoming message (any rule/status). */
  async onIncomingMessage(info: { telegramUserId: bigint; label: string; preview: string }): Promise<void> {
    const tasks = await this.d.db.assistantTask.findMany({ where: { active: true, kind: 'WATCH_MESSAGE', targetTelegramUserId: info.telegramUserId } });
    for (const task of tasks) {
      const claimed = await this.d.db.assistantTask.updateMany({
        where: { id: task.id, active: true },
        data: { lastTriggeredAt: this.now(), triggerCount: { increment: 1 }, ...(task.repeat ? {} : { active: false }) },
      });
      if (claimed.count === 0) continue;
      await this.d.notifier.text(`✉️ <b>${escapeHtml(task.targetLabel ?? info.label)}</b> yozdi:\n«${escapeHtml(info.preview.slice(0, 500))}»`);
    }
  }

  /** Job `assistant.remind`. */
  async runReminder(taskId: number): Promise<void> {
    const claimed = await this.d.db.assistantTask.updateMany({
      where: { id: taskId, kind: 'REMINDER', active: true },
      data: { active: false, lastTriggeredAt: this.now(), triggerCount: { increment: 1 } },
    });
    if (claimed.count === 0) return;
    const task = await this.d.db.assistantTask.findUniqueOrThrow({ where: { id: taskId } });
    await this.d.notifier.text(`⏰ <b>Eslatma:</b> ${escapeHtml(this.d.cipher.decrypt(task.text) ?? '')}`);
  }

  /** Scheduler tick: poll presence of watched people (push updates are not guaranteed) and drop stale drafts. */
  async tick(): Promise<void> {
    await this.d.db.assistantTask.deleteMany({
      where: { active: false, confirmed: false, createdAt: { lt: new Date(this.now().getTime() - DRAFT_TTL_MS) } },
    });
    const api = this.userbot;
    if (!api?.isReady()) return;
    const watches = await this.d.db.assistantTask.findMany({
      where: { active: true, kind: 'WATCH_ONLINE', targetTelegramUserId: { not: null } },
      select: { targetTelegramUserId: true },
      distinct: ['targetTelegramUserId'],
    });
    const ids = watches.map((w) => w.targetTelegramUserId).filter((v): v is bigint => v !== null);
    if (ids.length === 0) return;
    const users = await this.d.db.telegramUser.findMany({ where: { telegramUserId: { in: ids } }, select: { telegramUserId: true, accessHash: true } });
    const hash = new Map(users.map((u) => [u.telegramUserId, u.accessHash]));
    const states = await api.presence(ids.map((id) => ({ id, accessHash: hash.get(id) ?? null })));
    for (const [id, state] of states) await this.onPresence(id, state);
  }
}

/** Why the assistant could not answer: say so plainly instead of pretending the command was unclear. */
function aiDownText(error: unknown): string {
  const tip = 'Shu paytda ham ishlaydi: <i>10 minutdan keyin eslat</i>, <i>vazifalarim</i>, /menu.';
  if (isRateLimitFailure(error))
    return `⏳ <b>AI limiti tugadi.</b> Bepul Gemini kalitida har modelga kuniga ~20 ta so‘rov bor; limit Tinch okeani vaqti bilan yarim tunda (Toshkentda taxminan 12:00–13:00) yangilanadi. Doimiy ishlashi uchun kalitda billing yoqing.\n\n${tip}`;
  return `⚠️ <b>AI hozir javob bermadi</b> (Google tomonida sekinlik yoki band). Birozdan keyin qayta yozing; sababini /logs da ko‘rasiz.\n\n${tip}`;
}

function labelOf(u: { username: string | null; firstName: string | null; lastName: string | null; telegramUserId: bigint }): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  if (name && u.username) return `${name} (@${u.username})`;
  return name || (u.username ? `@${u.username}` : `id ${u.telegramUserId}`);
}
