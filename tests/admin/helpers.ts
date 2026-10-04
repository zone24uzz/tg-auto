import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { vi } from 'vitest';
import { parseEnv } from '../../src/config/env.js';
import { buildDefaultSettings, type Settings } from '../../src/settings/schema.js';
import type { AdminDeps } from '../../src/telegram/admin/deps.js';
import { createAdminComposer } from '../../src/telegram/admin/index.js';

export const ADMIN_ID = 424242n;
export const STRANGER_ID = 777001;

export function testSettings(overrides: Partial<Settings> = {}): Settings {
  const env = parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/test',
    TELEGRAM_BOT_TOKEN: `123456:${'A'.repeat(35)}`,
    ADMIN_TELEGRAM_USER_ID: ADMIN_ID.toString(),
  });
  return { ...buildDefaultSettings(env), ownerName: 'Komron', ...overrides };
}

interface StateRow {
  state: string;
  payload: unknown;
  expiresAt: Date;
}

/** In-memory stand-in for the `admin_states` table. */
export function fakeAdminStateTable() {
  const rows = new Map<string, StateRow>();
  return {
    rows,
    upsert: vi.fn(async (q: { where: { telegramUserId: bigint }; create: StateRow; update: StateRow }) => {
      const key = q.where.telegramUserId.toString();
      const data = rows.has(key) ? q.update : q.create;
      rows.set(key, { state: data.state, payload: data.payload, expiresAt: data.expiresAt });
      return { telegramUserId: q.where.telegramUserId, ...data, updatedAt: new Date() };
    }),
    findUnique: vi.fn(async (q: { where: { telegramUserId: bigint } }) => {
      const row = rows.get(q.where.telegramUserId.toString());
      return row ? { telegramUserId: q.where.telegramUserId, ...row, updatedAt: new Date() } : null;
    }),
    deleteMany: vi.fn(async (q: { where: { telegramUserId: bigint } }) => ({
      count: rows.delete(q.where.telegramUserId.toString()) ? 1 : 0,
    })),
  };
}

/** Minimal deps: settings, admin_states, counters for the main menu. Tests add what they touch. */
export function baseDeps(settings: Settings = testSettings()) {
  let current = settings;
  const adminState = fakeAdminStateTable();
  const deps = {
    adminTelegramUserId: ADMIN_ID,
    timezone: 'Asia/Tashkent',
    encryptionEnabled: true,
    db: { adminState },
    settings: {
      get: vi.fn(async () => current),
      set: vi.fn(async (key: keyof Settings, value: unknown, _adminId?: bigint) => {
        current = { ...current, [key]: value };
        return value;
      }),
      validate: vi.fn((_key: keyof Settings, value: unknown) => value),
    },
    attention: { countPending: vi.fn(async () => 3) },
    usage: { costToday: vi.fn(async () => 0.42) },
    events: { error: vi.fn(async () => undefined) },
  };
  return { deps, adminState, currentSettings: () => current };
}

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

const BOT_INFO = {
  id: 999,
  is_bot: true,
  first_name: 'Admin',
  username: 'test_admin_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: true,
  has_main_web_app: false,
} as UserFromGetMe;

/** A real grammY bot with the admin composer; API calls are recorded and faked (no network). */
export function createTestBot(deps: object) {
  const bot = new Bot(`123456:${'B'.repeat(35)}`, { botInfo: BOT_INFO });
  const calls: ApiCall[] = [];
  const passedThrough: number[] = [];
  let messageId = 1000;
  bot.api.config.use(async (_prev, method, payload) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, payload: p });
    const result =
      method === 'sendMessage' || method === 'editMessageText'
        ? { message_id: ++messageId, date: 0, chat: { id: Number(p.chat_id ?? 0), type: 'private', first_name: 'X' }, text: p.text }
        : true;
    return { ok: true, result } as never;
  });
  bot.use(createAdminComposer(deps as unknown as AdminDeps));
  bot.use((ctx) => {
    passedThrough.push(ctx.update.update_id);
  });
  return { bot, calls, passedThrough };
}

let updateSeq = 1;

export function messageUpdate(fromId: number | bigint, text: string, chat: 'private' | 'group' = 'private'): Update {
  const id = Number(fromId);
  const command = text.startsWith('/') ? text.split(/\s/)[0] ?? text : undefined;
  return {
    update_id: updateSeq++,
    message: {
      message_id: updateSeq,
      date: 0,
      chat: chat === 'private' ? { id, type: 'private', first_name: 'U' } : { id: -100123, type: 'group', title: 'G' },
      from: { id, is_bot: false, first_name: 'U' },
      text,
      ...(command ? { entities: [{ type: 'bot_command' as const, offset: 0, length: command.length }] } : {}),
    },
  } as Update;
}

export function photoUpdate(fromId: number | bigint): Update {
  const id = Number(fromId);
  return {
    update_id: updateSeq++,
    message: {
      message_id: updateSeq,
      date: 0,
      chat: { id, type: 'private', first_name: 'U' },
      from: { id, is_bot: false, first_name: 'U' },
      photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }],
    },
  } as Update;
}

export function callbackUpdate(fromId: number | bigint, data: string): Update {
  const id = Number(fromId);
  return {
    update_id: updateSeq++,
    callback_query: {
      id: `cq${updateSeq}`,
      from: { id, is_bot: false, first_name: 'U' },
      chat_instance: 'ci',
      data,
      message: { message_id: 55, date: 0, chat: { id, type: 'private', first_name: 'U' }, text: 'old' },
    },
  } as Update;
}

export function businessMessageUpdate(fromId: number): Update {
  return {
    update_id: updateSeq++,
    business_message: {
      message_id: 1,
      date: 0,
      business_connection_id: 'bc',
      chat: { id: fromId, type: 'private', first_name: 'U' },
      from: { id: fromId, is_bot: false, first_name: 'U' },
      text: '/start',
    },
  } as Update;
}

/** All text the bot sent or edited, joined (for "no leak" assertions). */
export function sentTexts(calls: ApiCall[]): string {
  return calls
    .filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText')
    .map((c) => String(c.payload.text ?? ''))
    .join('\n---\n');
}

export function callsOf(calls: ApiCall[], method: string): ApiCall[] {
  return calls.filter((c) => c.method === method);
}
