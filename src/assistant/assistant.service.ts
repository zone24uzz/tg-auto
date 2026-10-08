import type { PresenceState, UserbotAssistantApi } from '../app/userbot-contract.js';
import type { AiRouter } from '../ai/router/types.js';
import type { Db } from '../database/client.js';
import type { AssistantTask, AssistantTaskKind } from '../generated/prisma/client.js';
import type { EventLog } from '../logging/events.js';
import { childLogger } from '../logging/logger.js';
import { describeError } from '../logging/sanitize.js';
import type { PgQueue } from '../queues/pg-queue.js';
import type { ContentCipher } from '../security/crypto.js';
import { cb } from '../telegram/admin/callback-data.js';
import { escapeHtml } from '../telegram/common/html.js';
import { formatDateTime } from '../utils/time.js';
import { parseOwnerIntent, type OwnerIntent } from './intent.js';
import { PersonResolver, type PersonCandidate } from './resolver.js';

const log = childLogger('assistant');

export const ASSISTANT_ROUTE = 'as';
const DEFAULT_COOLDOWN_MIN = 30;
const DRAFT_TTL_MS = 24 * 3_600_000;
const MAX_ACTIVE_TASKS = 50;

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

/** The admin UI depends only on this. */
export interface AssistantPort {
  handleText(text: string): Promise<AssistantReply>;
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
].join('\n');

/**
 * The owner's personal assistant: free-text commands from the admin chat become tasks
 * (presence watches, message watches, reminders, messages sent on the owner's behalf after ✅).
 * Only the owner can reach this (the admin guard runs first); contacts never trigger actions.
 */
export class OwnerAssistant implements AssistantPort {
  private userbot: UserbotAssistantApi | null = null;
  private readonly resolver: PersonResolver;

  constructor(private readonly d: AssistantDeps) {
    this.resolver = new PersonResolver(d.db, () => this.userbot);
  }

  attachUserbot(api: UserbotAssistantApi | null): void {
    this.userbot = api;
  }

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  // ── admin chat entry points ────────────────────────────────────────────

  async handleText(text: string): Promise<AssistantReply> {
    let intent: OwnerIntent;
    try {
      intent = await parseOwnerIntent(this.d.ai, text, this.now(), this.d.timezone);
    } catch (error) {
      log.warn({ error: describeError(error) }, 'could not parse the owner command');
      return { text: '🤔 Buyruqni tushuna olmadim (yoki AI hozir band). Boshqacharoq yozib ko‘ring.\n\n' + HELP };
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
        return this.personTask(intent);
      case 'help':
        return { text: HELP };
      default:
        return { text: `${intent.reply ? `${escapeHtml(intent.reply)}\n\n` : ''}${HELP}` };
    }
  }

  async handleAction(args: string[]): Promise<AssistantReply> {
    const [verb, a, b] = args;
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
        const user = await this.d.db.telegramUser.findUnique({ where: { telegramUserId: BigInt(b) } });
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
      return { text: '⚠️ Buning uchun userbot ulangan bo‘lishi kerak. /login orqali ulang.' };
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
      const user = await this.d.db.telegramUser.findUnique({ where: { telegramUserId: person.telegramUserId } });
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

function labelOf(u: { username: string | null; firstName: string | null; lastName: string | null; telegramUserId: bigint }): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  if (name && u.username) return `${name} (@${u.username})`;
  return name || (u.username ? `@${u.username}` : `id ${u.telegramUserId}`);
}
