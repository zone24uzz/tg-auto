import { z } from 'zod';
import type { AiRouter } from '../ai/router/types.js';
import { extractJson } from '../classifiers/classifier.js';
import { formatDateTime, tzOffsetMs } from '../utils/time.js';

export const ASSISTANT_ACTIONS = [
  'watch_online',
  'watch_message',
  'remind',
  'send_message',
  'list_tasks',
  'cancel_task',
  'channel_post',
  'list_channels',
  'calendar_list',
  'calendar_add',
  'calendar_connect',
  'calendar_disconnect',
  'busy_set',
  'busy_clear',
  'work_hours',
  'learn_style',
  'birthday_set',
  'birthdays_list',
  'morning_summary',
  'backup_now',
  'help',
  'chat',
  'unknown',
] as const;
export type AssistantAction = (typeof ASSISTANT_ACTIONS)[number];

export interface OwnerIntent {
  action: AssistantAction;
  /** Name / @username / id exactly as the owner wrote it (suffixes like -ga, -ni removed). */
  person?: string;
  repeat: boolean;
  remindAt?: Date;
  /** Reminder text or the message to send on the owner's behalf. */
  text?: string;
  taskId?: number;
  /** chat only: the answer needs current information from the internet. */
  needsSearch: boolean;
  /** channel_post: which channel (title / @username) when the owner names one. */
  channel?: string;
  /** channel_post: `text` is the exact post to publish as-is (not instructions to write one). */
  exact: boolean;
  /** calendar_*: range start / event start, and range end / event end. */
  startAt?: Date;
  endAt?: Date;
  /** The answer for `chat` (the owner's question/conversation), or a short clarification otherwise. */
  reply: string;
}

const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...ASSISTANT_ACTIONS] },
    person: { type: 'string', description: 'name, @username or numeric id as written by the owner; empty if none' },
    repeat: { type: 'boolean', description: 'true only when the owner asks for every time / always' },
    remind_at: { type: 'string', description: 'absolute ISO 8601 date-time with offset for reminders; empty otherwise' },
    text: { type: 'string', description: 'reminder text or the exact message to send; empty otherwise' },
    task_id: { type: 'integer', description: 'task number for cancel_task; 0 if none' },
    reply: { type: 'string', description: 'for chat: the full helpful answer; otherwise one short sentence. Plain text, no markdown' },
    channel: { type: 'string', description: 'channel_post: channel title or @username if the owner named one; empty otherwise' },
    exact: { type: 'boolean', description: 'channel_post: true only when the owner gave the exact post text to publish as-is' },
    start_at: { type: 'string', description: 'calendar_list: range start; calendar_add: event start. Absolute ISO 8601 with offset; empty if not given' },
    end_at: { type: 'string', description: 'calendar_list: range end; calendar_add: event end (empty = 1 hour). Absolute ISO 8601 with offset' },
    needs_search: {
      type: 'boolean',
      description: 'chat / channel_post: true ONLY when the answer or post needs current information from the internet (news, “latest”, “bugungi”, prices, exchange rates, weather, sports results, recent events). A post about a general topic, tips or the owner’s own services = false',
    },
  },
  required: ['action', 'person', 'repeat', 'remind_at', 'text', 'task_id', 'reply', 'needs_search', 'channel', 'exact', 'start_at', 'end_at'],
} as const;

const rawSchema = z.object({
  action: z.enum(ASSISTANT_ACTIONS),
  person: z.string().max(100).optional().default(''),
  repeat: z.boolean().optional().default(false),
  remind_at: z.string().max(60).optional().default(''),
  text: z.string().max(2000).optional().default(''),
  task_id: z.number().int().min(0).optional().default(0),
  reply: z.string().max(3000).optional().default(''),
  needs_search: z.boolean().optional().default(false),
  channel: z.string().max(100).optional().default(''),
  exact: z.boolean().optional().default(false),
  start_at: z.string().max(60).optional().default(''),
  end_at: z.string().max(60).optional().default(''),
});

function systemPrompt(now: Date, timezone: string): string {
  const offsetMin = Math.round(tzOffsetMs(now, timezone) / 60_000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const offset = `${sign}${String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, '0')}:${String(Math.abs(offsetMin) % 60).padStart(2, '0')}`;
  return [
    "You convert the OWNER's commands to their personal Telegram assistant into JSON. Commands are usually Uzbek (Latin or Cyrillic), sometimes Russian or English.",
    `Current local time: ${formatDateTime(now, timezone)} ${now.getUTCFullYear()} (${timezone}, UTC${offset}). Today is ${new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(now)}.`,
    'Actions:',
    '- watch_online: tell the owner when a person comes online on Telegram ("X online bo\'lsa / tg ga kirganda / kirsa menga xabar ber", "X kirganda ayt").',
    '- watch_message: tell the owner immediately when a person writes ("X yozsa darhol ayt", "X dan xabar kelsa bildir").',
    `- remind: remind the owner at a time, including timers ("soat 18:00 da ... eslat", "2 soatdan keyin ...", "10 minutga timer qo‘y", "budilnik 7:00"). remind_at = absolute ISO 8601 with offset ${offset}; text = what to remind.`,
    '- send_message: send a message to a person on the owner\'s behalf ("X ga yoz: ...", "X ga ayt ..."). text = the message exactly as it should be sent, in the language the owner used, without quotes.',
    '- list_tasks: show the active tasks ("vazifalar", "kuzatuvlar", "nima kuzatyapsan").',
    '- cancel_task: stop a task ("X kuzatuvini o\'chir" → person; "3-vazifani o\'chir" → task_id).',
    '- channel_post: write/publish a post in the owner’s Telegram channel ("kanalga post yoz: …", "kanalga joyla: …", "написать пост в канал"). text = the topic/instructions, or the exact text when the owner gave it (then exact=true); channel = the channel name if given.',
    '- list_channels: show the connected channels ("kanallarim", "qaysi kanallar ulangan").',
    '- calendar_list: the owner asks about their schedule ("bugun nima rejalarim bor", "ertaga bandmanmi", "shu hafta"). start_at/end_at = the asked period (default: today 00:00–23:59).',
    '- calendar_add: add an event to the owner’s Google Calendar ("ertaga 15:00 ga Ali bilan uchrashuv qo‘sh"). text = event title; start_at = start; end_at = end if given.',
    '- calendar_connect / calendar_disconnect: connect or disconnect Google Calendar ("kalendarni ula", "kalendarni uz").',
    '- busy_set: the owner says they are busy for a while ("2 soat uchrashuvdaman", "17:00 gacha bandman", "1 soat yo‘qman", "я на встрече до 5"). end_at = until when (absolute ISO with offset; from a duration count from now); text = a very short reason in the owner’s words if given ("uchrashuvda", "yo‘ldaman"), else empty.',
    '- busy_clear: the owner is free again ("bo‘shadim", "bandlikni o‘chir", "uchrashuv tugadi").',
    '- work_hours: the owner sets working hours ("ish vaqtim 9 dan 18 gacha"). start_at / end_at = today at those times (ISO with offset).',
    '- learn_style: "uslubimni o‘rgan", "mening yozish uslubimni o‘rgan".',
    '- birthday_set: the owner tells a contact’s birthday ("Alining tug‘ilgan kuni 12-mart"). person = who; text = the date exactly as written; start_at = that date (ISO; current year if no year given).',
    '- birthdays_list: "tug‘ilgan kunlar", "kimning tug‘ilgan kuni yaqin".',
    '- morning_summary: the owner asks for today’s summary / overview ("bugungi xulosa", "kun xulosasi", "bugun nima bor").',
    '- backup_now: "zaxira nusxa ol", "backup qil".',
    '- help: the owner asks what you can do.',
    '- chat: anything else — a question, a request for advice, text to write/translate/fix, small talk. Answer it yourself in `reply`: helpful, accurate, concise (usually 1–6 sentences, longer only if asked), in the language the owner wrote in, plain text without markdown. Do not invent facts about the owner’s contacts.',
    'person = the name, @username or numeric id exactly as written, without Uzbek case suffixes (Firdavsga → Firdavs, Alini → Ali). repeat = true only for "har safar / doim / always / har gal", otherwise false.',
    'Never invent people, times or texts. For actions other than chat, reply = one short friendly sentence in the owner’s language confirming what you understood or asking for what is missing.',
    'Return only the JSON object.',
  ].join('\n');
}

/** Parses an owner's free-text command. Throws when the model output cannot be used. */
export async function parseOwnerIntent(ai: AiRouter, text: string, now: Date, timezone: string): Promise<OwnerIntent> {
  const routed = await ai.classify({
    system: systemPrompt(now, timezone),
    messages: [{ role: 'user', parts: [{ type: 'text', text: text.slice(0, 2000) }] }],
    json: { schema: INTENT_SCHEMA as unknown as Record<string, unknown>, name: 'owner_command' },
    maxOutputTokens: 1200,
    temperature: 0,
    // Interactive: a hanging model must fail fast so the fallback model answers.
    timeoutMs: 30_000,
  });
  const raw = rawSchema.parse(JSON.parse(extractJson(routed.result.text)));
  return normalizeIntent(raw, now);
}

/** Validates model output into a safe intent (pure; exported for tests). */
export function normalizeIntent(raw: z.input<typeof rawSchema>, now: Date): OwnerIntent {
  const r = rawSchema.parse(raw);
  const person = r.person.trim().replace(/^["«“']+|["»”']+$/g, '');
  let remindAt: Date | undefined;
  if (r.remind_at.trim()) {
    const d = new Date(r.remind_at.trim());
    if (!Number.isNaN(d.getTime())) remindAt = d;
  }
  // A reminder in the past or more than a year away is a misunderstanding, not a task.
  if (remindAt && (remindAt.getTime() < now.getTime() - 60_000 || remindAt.getTime() > now.getTime() + 366 * 86_400_000)) remindAt = undefined;
  return {
    action: r.action,
    ...(person ? { person } : {}),
    repeat: r.repeat,
    ...(remindAt ? { remindAt } : {}),
    ...(r.text.trim() ? { text: r.text.trim() } : {}),
    ...(r.task_id > 0 ? { taskId: r.task_id } : {}),
    reply: r.reply.trim(),
    needsSearch: (r.action === 'chat' || r.action === 'channel_post') && r.needs_search,
    ...(r.channel.trim() ? { channel: r.channel.trim() } : {}),
    exact: r.action === 'channel_post' && r.exact,
    ...(isoDate(r.start_at) ? { startAt: isoDate(r.start_at)! } : {}),
    ...(isoDate(r.end_at) ? { endAt: isoDate(r.end_at)! } : {}),
  };
}

/** A valid absolute date from model output, or undefined. */
function isoDate(value: string): Date | undefined {
  if (!value.trim()) return undefined;
  const d = new Date(value.trim());
  return Number.isNaN(d.getTime()) ? undefined : d;
}
