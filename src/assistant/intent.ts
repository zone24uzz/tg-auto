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
  'help',
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
  /** Short Uzbek reply for help/unknown or a clarification. */
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
    reply: { type: 'string', description: 'short Uzbek reply, no markdown' },
  },
  required: ['action', 'person', 'repeat', 'remind_at', 'text', 'task_id', 'reply'],
} as const;

const rawSchema = z.object({
  action: z.enum(ASSISTANT_ACTIONS),
  person: z.string().max(100).optional().default(''),
  repeat: z.boolean().optional().default(false),
  remind_at: z.string().max(60).optional().default(''),
  text: z.string().max(2000).optional().default(''),
  task_id: z.number().int().min(0).optional().default(0),
  reply: z.string().max(500).optional().default(''),
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
    `- remind: remind the owner at a time ("soat 18:00 da ... eslat", "2 soatdan keyin ..."). remind_at = absolute ISO 8601 with offset ${offset}; text = what to remind.`,
    '- send_message: send a message to a person on the owner\'s behalf ("X ga yoz: ...", "X ga ayt ..."). text = the message exactly as it should be sent, in the language the owner used, without quotes.',
    '- list_tasks: show the active tasks ("vazifalar", "kuzatuvlar", "nima kuzatyapsan").',
    '- cancel_task: stop a task ("X kuzatuvini o\'chir" → person; "3-vazifani o\'chir" → task_id).',
    '- help: what can you do. unknown: anything else.',
    'person = the name, @username or numeric id exactly as written, without Uzbek case suffixes (Firdavsga → Firdavs, Alini → Ali). repeat = true only for "har safar / doim / always / har gal", otherwise false.',
    'Never invent people, times or texts. reply = one short friendly Uzbek sentence (no markdown) confirming what you understood or asking for what is missing.',
    'Return only the JSON object.',
  ].join('\n');
}

/** Parses an owner's free-text command. Throws when the model output cannot be used. */
export async function parseOwnerIntent(ai: AiRouter, text: string, now: Date, timezone: string): Promise<OwnerIntent> {
  const routed = await ai.classify({
    system: systemPrompt(now, timezone),
    messages: [{ role: 'user', parts: [{ type: 'text', text: text.slice(0, 2000) }] }],
    json: { schema: INTENT_SCHEMA as unknown as Record<string, unknown>, name: 'owner_command' },
    maxOutputTokens: 500,
    temperature: 0,
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
  };
}
