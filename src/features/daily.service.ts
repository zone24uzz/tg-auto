import type { AiRouter } from '../ai/router/types.js';
import type { UserbotAssistantApi } from '../app/userbot-contract.js';
import type { Db } from '../database/client.js';
import type { TelegramUser } from '../generated/prisma/client.js';
import type { CalendarService } from '../google/calendar.service.js';
import { childLogger } from '../logging/logger.js';
import { describeError } from '../logging/sanitize.js';
import type { OwnerAttentionService } from '../owner-attention/attention.service.js';
import type { ContentCipher } from '../security/crypto.js';
import type { SettingKey } from '../settings/schema.js';
import type { SettingsService } from '../settings/settings.service.js';
import { cb } from '../telegram/admin/callback-data.js';
import { escapeHtml } from '../telegram/common/html.js';
import { currentTenantId, currentTenantOrNull } from '../tenancy/context.js';
import { formatDateTime, formatTime, localDateKey, startOfDayInTz, tzOffsetMs } from '../utils/time.js';
import type { BackupService } from './backup.service.js';
import { detectLanguage, languageInstruction } from './language.js';
import type { StyleService } from './style.service.js';

const log = childLogger('daily');

/** Daily backup runs at the first scheduler tick after this local hour (quietly, at night). */
const BACKUP_HOUR = 3;
/** A morning summary that is this late (e.g. after a long outage) is skipped for the day. */
const SUMMARY_LATE_MS = 3 * 3_600_000;
const MONTHS_UZ = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
const WEEKDAYS_UZ = ['yakshanba', 'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba'];

export interface DailyButton {
  label: string;
  data: string;
}

export interface DailyDeps {
  db: Db;
  ai: AiRouter;
  cipher: ContentCipher;
  settings: SettingsService;
  notifier: {
    text(html: string, opts?: { silent?: boolean; buttons?: DailyButton[][] }): Promise<number | undefined>;
    document(file: Buffer, filename: string, caption: string, opts?: { silent?: boolean }): Promise<boolean>;
  };
  attention: Pick<OwnerAttentionService, 'listPending'>;
  backup: BackupService;
  style: StyleService;
  calendar?: CalendarService;
  /** The workspace's userbot (null when not logged in): sends greetings, reads contact birthdays. */
  userbot: () => UserbotAssistantApi | null;
  /** callback_data for the assistant buttons (as|…). */
  button: (...args: Array<string | number | bigint>) => string;
  /**
   * The backup is encrypted with this server's key, which only the bot's administrator holds:
   * only the administrator's workspace gets it (undefined = every workspace, e.g. in tests).
   */
  backupOwnerId?: bigint;
  timezone: string;
  now?: () => Date;
}

/** "MM-DD" of a local date. */
function monthDay(date: Date, timezone: string): string {
  return localDateKey(date, timezone).slice(5);
}

/** A date the owner gave → stored MM-DD (or YYYY-MM-DD when the year matters). */
export function normalizeBirthday(date: Date, withYear: boolean, timezone: string): string {
  const key = localDateKey(date, timezone);
  return withYear ? key : key.slice(5);
}

export function formatBirthday(value: string): string {
  const m = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  const month = MONTHS_UZ[Number(m[2]) - 1] ?? m[2];
  return `${Number(m[3])}-${month}${m[1] ? ` ${m[1]}` : ''}`;
}

function nameOf(u: Pick<TelegramUser, 'firstName' | 'lastName' | 'username' | 'telegramUserId'>): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  if (name && u.username) return `${name} (@${u.username})`;
  return name || (u.username ? `@${u.username}` : `id ${u.telegramUserId}`);
}

/**
 * The owner's daily routines, run from the per-workspace scheduler tick:
 * busy mode expiry, the morning summary (calendar, waiting messages, reminders, birthdays),
 * birthday greetings with a ready draft, the nightly backup and the weekly style refresh.
 * Each daily step is claimed once per local day across processes.
 */
export class DailyService {
  /** Per workspace: local day of the last Telegram birthday sync. */
  private readonly birthdaySync = new Map<number, string>();

  constructor(private readonly d: DailyDeps) {}

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  private localMinutes(now: Date): number {
    const local = new Date(now.getTime() + tzOffsetMs(now, this.d.timezone));
    return local.getUTCHours() * 60 + local.getUTCMinutes();
  }

  /** Atomically flips a per-day bookkeeping setting to `day`; true for exactly one caller. */
  private async claimDay(key: SettingKey, day: string): Promise<boolean> {
    // Raw SQL is not tenant-scoped by the Prisma extension: the tenant goes in explicitly.
    const tenantId = currentTenantId('daily');
    const won = await this.d.db.$queryRaw<Array<{ key: string }>>`
      INSERT INTO settings ("tenantId", key, value, "updatedAt")
      VALUES (${tenantId}, ${key}, ${JSON.stringify(day)}::jsonb, now())
      ON CONFLICT ("tenantId", key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()
       WHERE settings.value IS DISTINCT FROM EXCLUDED.value
      RETURNING key`;
    this.d.settings.invalidate();
    return won.length > 0;
  }

  /** Scheduler tick for the current workspace. Every step is independent: one failing never blocks the others. */
  async tick(): Promise<void> {
    const steps: Array<[string, () => Promise<void>]> = [
      ['busy expiry', () => this.expireBusy()],
      ['morning summary', () => this.morningIfDue()],
      ['backup', () => this.backupIfDue()],
      ['style', () => this.d.style.refreshIfDue()],
    ];
    for (const [name, step] of steps) {
      await step().catch((error: unknown) => log.warn({ error: describeError(error), step: name }, 'daily step failed'));
    }
  }

  // ── busy mode ──────────────────────────────────────────────────────────

  async setBusy(until: Date, note: string): Promise<void> {
    await this.d.settings.set('busyNote', note.trim().slice(0, 200));
    await this.d.settings.set('busyUntil', until.toISOString());
  }

  /** Ends busy mode now; false when it was not on. */
  async clearBusy(): Promise<boolean> {
    const s = await this.d.settings.get();
    const on = s.busyUntil !== null && new Date(s.busyUntil).getTime() > this.now().getTime();
    if (s.busyUntil !== null) await this.d.settings.set('busyUntil', null);
    return on;
  }

  private async expireBusy(): Promise<void> {
    this.d.settings.invalidate();
    const s = await this.d.settings.get();
    if (!s.busyUntil || new Date(s.busyUntil).getTime() > this.now().getTime()) return;
    const tenantId = currentTenantId('busy');
    // Conditional clear: exactly one process tells the owner.
    const changed = await this.d.db.$executeRaw`
      UPDATE settings SET value = 'null'::jsonb, "updatedAt" = now()
       WHERE "tenantId" = ${tenantId} AND key = 'busyUntil' AND value = ${JSON.stringify(s.busyUntil)}::jsonb`;
    this.d.settings.invalidate();
    if (changed === 1) await this.d.notifier.text('🟢 «Bandman» rejimi tugadi — mijozlarga endi bandligingiz aytilmaydi.');
  }

  // ── morning summary ────────────────────────────────────────────────────

  private async morningIfDue(): Promise<void> {
    const s = await this.d.settings.get();
    if (!s.morningSummaryEnabled && !s.birthdayRemindersEnabled) return;
    const now = this.now();
    const [h, m] = s.morningSummaryTime.split(':').map(Number);
    const due = (h ?? 8) * 60 + (m ?? 0);
    const minutes = this.localMinutes(now);
    if (minutes < due) return;
    // Birthdays first (so the summary lists contacts just synced from Telegram).
    if (s.birthdayRemindersEnabled || s.morningSummaryEnabled)
      await this.syncTelegramBirthdays().catch((error: unknown) => log.warn({ error: describeError(error) }, 'birthday sync failed'));
    const today = localDateKey(now, this.d.timezone);
    // A summary that would arrive hours late (long outage) is skipped for the day.
    if (s.morningSummaryEnabled && (minutes - due) * 60_000 <= SUMMARY_LATE_MS && s.morningSummarySentOn !== today) {
      if (await this.claimDay('morningSummarySentOn', today)) await this.sendMorningSummary();
    }
    // Greetings any time later that day: each person is claimed once per year.
    if (s.birthdayRemindersEnabled) await this.birthdayGreetings();
  }

  /** The summary itself (also on demand: "bugungi xulosa"). */
  async morningSummaryText(): Promise<{ text: string; buttons: DailyButton[][] }> {
    const tz = this.d.timezone;
    const now = this.now();
    const dayStart = startOfDayInTz(now, tz);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const local = new Date(now.getTime() + tzOffsetMs(now, tz));
    const lines = [
      `☀️ <b>Xayrli tong!</b> Bugun ${local.getUTCDate()}-${MONTHS_UZ[local.getUTCMonth()]}, ${WEEKDAYS_UZ[local.getUTCDay()]}.`,
    ];

    const calendar = this.d.calendar;
    if (calendar?.configured() && calendar.allowed() && (await calendar.account())) {
      try {
        const events = await calendar.listEvents(now, dayEnd);
        lines.push('', events.length ? '📅 <b>Bugungi rejalar:</b>' : '📅 Bugun kalendarda reja yo‘q.');
        for (const e of events.slice(0, 8))
          lines.push(`• ${e.allDay ? 'kun bo‘yi' : `${formatTime(e.start, tz)}–${formatTime(e.end, tz)}`} — ${escapeHtml(e.summary)}`);
      } catch (error) {
        log.warn({ error: describeError(error) }, 'calendar in morning summary failed');
        lines.push('', '📅 Kalendarni o‘qib bo‘lmadi.');
      }
    }

    const pending = await this.d.attention.listPending(3, 0);
    if (pending.total > 0) {
      lines.push('', `🔔 <b>Javobingizni kutayotganlar: ${pending.total}</b>`);
      for (const it of pending.items) lines.push(`• ${escapeHtml(it.userLabel)}: «${escapeHtml(it.text.slice(0, 60))}»`);
    } else lines.push('', '✅ Javob kutayotgan xabar yo‘q.');

    const reminders = await this.d.db.assistantTask.findMany({
      where: { active: true, kind: 'REMINDER', runAt: { gte: now, lt: dayEnd } },
      orderBy: { runAt: 'asc' },
      take: 8,
    });
    if (reminders.length > 0) {
      lines.push('', '⏰ <b>Bugungi eslatmalar:</b>');
      for (const r of reminders) lines.push(`• ${r.runAt ? formatTime(r.runAt, tz) : '?'} — ${escapeHtml(this.d.cipher.decrypt(r.text) ?? '')}`);
    }

    const birthdays = await this.birthdaysOn(now);
    if (birthdays.length > 0) {
      lines.push('', '🎂 <b>Bugun tug‘ilgan kun:</b>');
      for (const u of birthdays) lines.push(`• ${escapeHtml(nameOf(u))}`);
    }

    const yesterday = new Date(dayStart.getTime() - 86_400_000);
    const [incoming, answered] = await Promise.all([
      this.d.db.message.count({ where: { direction: 'INCOMING', createdAt: { gte: yesterday, lt: dayStart } } }),
      this.d.db.message.count({ where: { direction: 'INCOMING', status: 'ANSWERED', createdAt: { gte: yesterday, lt: dayStart } } }),
    ]);
    if (incoming > 0) lines.push('', `📊 Kecha: ${incoming} ta xabar keldi, AI ${answered} tasiga javob berdi.`);

    const s = await this.d.settings.get();
    if (s.busyUntil && new Date(s.busyUntil).getTime() > now.getTime())
      lines.push('', `⏳ «Bandman» rejimi ${formatDateTime(new Date(s.busyUntil), tz)} gacha yoqilgan.`);

    const buttons: DailyButton[][] = pending.total > 0 ? [[{ label: `🔔 Navbat (${pending.total})`, data: cb('oa.l', 0) }]] : [];
    return { text: lines.join('\n'), buttons };
  }

  private async sendMorningSummary(): Promise<void> {
    const { text, buttons } = await this.morningSummaryText();
    await this.d.notifier.text(text, { buttons });
  }

  // ── birthdays ──────────────────────────────────────────────────────────

  /** Contacts whose birthday is on the local day of `date`. */
  async birthdaysOn(date: Date): Promise<TelegramUser[]> {
    const md = monthDay(date, this.d.timezone);
    const days = [md];
    // 29 February birthdays are celebrated on 28 February in other years.
    const year = Number(localDateKey(date, this.d.timezone).slice(0, 4));
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    if (md === '02-28' && !leap) days.push('02-29');
    return this.d.db.telegramUser.findMany({
      where: { OR: days.flatMap((d) => [{ birthday: d }, { birthday: { endsWith: `-${d}` } }]) },
      orderBy: { id: 'asc' },
      take: 20,
    });
  }

  /** Birthdays coming up in the next `days` days (for "tug'ilgan kunlar"). */
  async upcomingBirthdays(days = 30): Promise<Array<{ user: TelegramUser; date: string; inDays: number }>> {
    const users = await this.d.db.telegramUser.findMany({ where: { birthday: { not: null } }, take: 500 });
    const now = this.now();
    const out: Array<{ user: TelegramUser; date: string; inDays: number }> = [];
    for (let i = 0; i <= days; i++) {
      const md = monthDay(new Date(now.getTime() + i * 86_400_000), this.d.timezone);
      for (const u of users) if (u.birthday === md || u.birthday?.endsWith(`-${md}`)) out.push({ user: u, date: u.birthday, inDays: i });
    }
    return out;
  }

  /** The owner told us a birthday ("Alining tug'ilgan kuni 12-mart"). Owner-set dates win over Telegram's. */
  async setBirthday(userId: number, birthday: string): Promise<void> {
    await this.d.db.telegramUser.update({ where: { id: userId }, data: { birthday, birthdaySource: 'owner' } });
  }

  /** Birthdays Telegram shows the owner for their contacts (userbot only), at most once a day. */
  async syncTelegramBirthdays(): Promise<number> {
    const api = this.d.userbot();
    if (!api?.isReady() || !api.birthdays) return 0;
    const key = currentTenantOrNull()?.tenantId ?? 0;
    const today = localDateKey(this.now(), this.d.timezone);
    if (this.birthdaySync.get(key) === today) return 0;
    // Marked done only after Telegram answered: a failed call is retried on the next tick.
    const found = await api.birthdays();
    this.birthdaySync.set(key, today);
    let changed = 0;
    for (const p of found) {
      const existing = await this.d.db.telegramUser.findFirst({ where: { telegramUserId: p.id } });
      if (existing?.birthdaySource === 'owner' || existing?.birthday === p.birthday) continue;
      if (existing) {
        await this.d.db.telegramUser.update({ where: { id: existing.id }, data: { birthday: p.birthday, birthdaySource: 'telegram' } });
      } else {
        await this.d.db.telegramUser.create({
          data: {
            telegramUserId: p.id,
            username: p.username ?? null,
            firstName: p.firstName ?? null,
            lastName: p.lastName ?? null,
            accessHash: p.accessHash ?? null,
            isContact: true,
            birthday: p.birthday,
            birthdaySource: 'telegram',
          },
        });
      }
      changed++;
    }
    return changed;
  }

  /** One notification per birthday person per year, with a ready greeting (✅ sends it via the userbot). */
  async birthdayGreetings(): Promise<void> {
    const now = this.now();
    const year = Number(localDateKey(now, this.d.timezone).slice(0, 4));
    for (const user of await this.birthdaysOn(now)) {
      // Claim first: another process (or a re-run) must not notify twice.
      const claimed = await this.d.db.telegramUser.updateMany({
        where: { id: user.id, OR: [{ birthdayNotifiedYear: null }, { birthdayNotifiedYear: { not: year } }] },
        data: { birthdayNotifiedYear: year },
      });
      if (claimed.count === 0) continue;
      const reply = await this.greetingReply(user);
      await this.d.notifier.text(reply.text, { buttons: reply.buttons });
    }
  }

  /** Greeting card for one person (also "🔄 another variant"). */
  async greetingReply(user: TelegramUser): Promise<{ text: string; buttons: DailyButton[][] }> {
    const greeting = await this.writeGreeting(user);
    const who = escapeHtml(nameOf(user));
    const head = `🎂 <b>Bugun ${who}ning tug‘ilgan kuni!</b>`;
    if (!greeting) return { text: `${head}\n\nTabrik yozishni unutmang 🙂`, buttons: [] };
    const again = { label: '🔄 Boshqa variant', data: this.d.button('bd', user.id) };
    if (this.d.userbot()?.isReady()) {
      const draft = await this.d.db.assistantTask.create({
        data: {
          kind: 'SEND_MESSAGE',
          targetTelegramUserId: user.telegramUserId,
          targetLabel: nameOf(user),
          text: this.d.cipher.encrypt(greeting),
          active: false,
          confirmed: false,
        },
      });
      return {
        text: `${head}\n\nTabrik varianti (sizning nomingizdan yuboriladi):\n«${escapeHtml(greeting)}»`,
        buttons: [[{ label: '✅ Yuborish', data: this.d.button('send', draft.id) }, again], [{ label: '❌ Kerak emas', data: this.d.button('no', draft.id) }]],
      };
    }
    // Without the userbot the bot cannot start a chat on the owner's behalf: copy-paste instead.
    return { text: `${head}\n\nTabrik varianti (bosib nusxa oling va o‘zingiz yuboring):\n<code>${escapeHtml(greeting)}</code>`, buttons: [[again]] };
  }

  private async writeGreeting(user: TelegramUser): Promise<string> {
    const s = await this.d.settings.get();
    const last = await this.d.db.message.findMany({
      where: { senderId: user.id, direction: 'INCOMING', deletedAt: null },
      orderBy: { id: 'desc' },
      take: 5,
      select: { currentText: true },
    });
    const sample = last.map((m) => this.d.cipher.decrypt(m.currentText) ?? '').join('\n');
    const language = detectLanguage(sample);
    const style = s.useStyleProfile && s.styleProfile.trim() ? s.styleProfile.trim() : '';
    try {
      const routed = await this.d.ai.generateReply({
        system: [
          `Write a short, warm birthday greeting (2–3 sentences) that ${s.ownerName} will send to a contact on Telegram, in the first person.`,
          'Sincere and natural, not over the top; 1–3 fitting emojis; no hashtags, no quotes, no signature.',
          "Do not invent shared memories or facts about the person. Use the person's first name only if it is given.",
          languageInstruction(language) || 'Write in Uzbek (Latin script).',
          style ? `${s.ownerName}'s writing style (imitate the manner only):\n${style}` : '',
          'Return only the greeting text.',
        ]
          .filter(Boolean)
          .join('\n'),
        messages: [{ role: 'user', parts: [{ type: 'text', text: `Contact's first name: ${(user.firstName ?? '').slice(0, 40) || '(unknown)'}` }] }],
        maxOutputTokens: 300,
        temperature: 0.9,
        timeoutMs: 30_000,
      });
      return routed.result.text.trim().replace(/^["«“]+|["»”]+$/g, '').slice(0, 800);
    } catch (error) {
      log.warn({ error: describeError(error) }, 'birthday greeting failed');
      return '';
    }
  }

  // ── backup ─────────────────────────────────────────────────────────────

  /** Only the administrator can open a backup (it needs the server key). */
  backupAvailable(): boolean {
    return this.d.backupOwnerId === undefined || currentTenantOrNull()?.ownerTelegramUserId === this.d.backupOwnerId;
  }

  private async backupIfDue(): Promise<void> {
    const s = await this.d.settings.get();
    if (!s.dailyBackupEnabled || !this.backupAvailable()) return;
    const now = this.now();
    if (this.localMinutes(now) < BACKUP_HOUR * 60) return;
    const today = localDateKey(now, this.d.timezone);
    if (s.backupDoneOn === today || !(await this.claimDay('backupDoneOn', today))) return;
    await this.sendBackup(true);
  }

  /** Creates the backup and sends it to the owner's chat; returns a status line. */
  async sendBackup(silent = false): Promise<string> {
    if (!this.backupAvailable()) return '💾 Zaxira nusxa faqat bot administratori uchun (u server kaliti bilan shifrlanadi).';
    const backup = await this.d.backup.create();
    const total = Object.values(backup.counts).reduce((a, b) => a + b, 0);
    const caption = [
      `💾 <b>Zaxira nusxa</b> — ${formatDateTime(this.now(), this.d.timezone)}`,
      `Kontaktlar: ${backup.counts.users ?? 0} · xabarlar (30 kun): ${backup.counts.messages ?? 0} · qoidalar: ${backup.counts.rules ?? 0}`,
      backup.encrypted ? '🔐 Shifrlangan: faqat shu server kaliti bilan ochiladi.' : '⚠️ Shifrlanmagan (DATA_ENCRYPTION_KEY yo‘q).',
    ].join('\n');
    const ok = await this.d.notifier.document(backup.file, backup.filename, caption, { silent });
    return ok ? `💾 Zaxira nusxa yuborildi (${total} ta yozuv).` : '❌ Zaxira faylini yuborib bo‘lmadi (📜 Logs).';
  }
}
