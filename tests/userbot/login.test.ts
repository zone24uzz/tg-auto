import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import type { Api as TgApi } from 'telegram';
import type { QrCodeAuthParams } from 'telegram/client/auth.js';
import { describe, expect, it, vi } from 'vitest';
import type { UserbotStatus } from '../../src/app/userbot-contract.js';
import { LoginController, createLoginComposer, parseCommand, type LoginBundle, type LoginClient, type LoginHost } from '../../src/telegram/userbot/login.js';
import { OWNER_ID, apiUser } from './helpers.js';

const ADMIN = Number(OWNER_ID);
const STRANGER = 777001;
const PASSWORD = 'hunter2-very-secret';

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

let seq = 1;
function messageUpdate(from: number, text: string, chatType: 'private' | 'group' = 'private'): Update {
  const id = seq++;
  return {
    update_id: id,
    message: {
      message_id: 10_000 + id,
      date: 0,
      chat: chatType === 'private' ? { id: from, type: 'private', first_name: 'U' } : { id: -100, type: 'group', title: 'G' },
      from: { id: from, is_bot: false, first_name: 'U' },
      text,
    },
  } as Update;
}

function callbackUpdate(from: number, data: string): Update {
  const id = seq++;
  return {
    update_id: id,
    callback_query: {
      id: `cb${id}`,
      from: { id: from, is_bot: false, first_name: 'U' },
      chat_instance: '1',
      data,
      message: { message_id: 55, date: 0, chat: { id: from, type: 'private', first_name: 'U' } },
    },
  } as Update;
}

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

function setup(signIn?: (params: QrCodeAuthParams) => Promise<unknown>) {
  let status: UserbotStatus = { state: 'login_required' };
  const me = apiUser(OWNER_ID, { username: 'owner', firstName: 'Owner' });
  const client: LoginClient = {
    connect: vi.fn(async () => true),
    signInUserWithQrCode: vi.fn(async (_creds, params: QrCodeAuthParams) => (signIn ? signIn(params) : new Promise(() => undefined))),
    getMe: vi.fn(async () => me),
  };
  const bundle: LoginBundle = { client };
  const host = {
    apiId: 1,
    apiHash: 'f'.repeat(32),
    adminTelegramUserId: OWNER_ID,
    status: () => status,
    newLoginClient: vi.fn(() => bundle),
    adopt: vi.fn(async (_b: LoginBundle, user: TgApi.User) => {
      status = { state: 'ready', userId: BigInt(String(user.id)), username: user.username };
      return { sessionSaved: true };
    }),
    discard: vi.fn(async () => undefined),
    loginFailed: vi.fn(),
    logout: vi.fn(async () => {
      status = { state: 'login_required' };
    }),
  } satisfies LoginHost<LoginBundle>;
  const controller = new LoginController(host);
  const bot = new Bot(`123456:${'B'.repeat(35)}`, { botInfo: BOT_INFO });
  const calls: Call[] = [];
  const passed: number[] = [];
  let messageId = 2000;
  bot.api.config.use(async (_prev, method, payload) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, payload: p });
    const result =
      method === 'sendMessage' || method === 'sendPhoto'
        ? { message_id: ++messageId, date: 0, chat: { id: Number(p.chat_id ?? 0), type: 'private', first_name: 'X' } }
        : true;
    return { ok: true, result } as never;
  });
  bot.use(createLoginComposer(host, controller));
  bot.use((ctx) => {
    passed.push(ctx.update.update_id);
  });
  const texts = () => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.payload.text));
  return { bot, calls, passed, host, controller, client, texts, setStatus: (s: UserbotStatus) => (status = s) };
}

describe('userbot login composer', () => {
  it('parses only its own commands (optionally addressed to this bot)', () => {
    expect(parseCommand('/login', 'test_admin_bot')).toBe('login');
    expect(parseCommand('/login@test_admin_bot', 'test_admin_bot')).toBe('login');
    expect(parseCommand('/login@other_bot', 'test_admin_bot')).toBeNull();
    expect(parseCommand('/start', 'test_admin_bot')).toBeNull();
    expect(parseCommand('login', 'test_admin_bot')).toBeNull();
  });

  it('passes non-admin /login to next() without replying', async () => {
    const { bot, calls, passed, host } = setup();
    const update = messageUpdate(STRANGER, '/login');
    await bot.handleUpdate(update);
    expect(passed).toEqual([update.update_id]);
    expect(calls).toEqual([]);
    expect(host.newLoginClient).not.toHaveBeenCalled();
  });

  it('passes admin messages in groups and non-admin logout callbacks through untouched', async () => {
    const { bot, calls, passed, host } = setup();
    const inGroup = messageUpdate(ADMIN, '/login', 'group');
    const strangerCb = callbackUpdate(STRANGER, 'ub.lo|y');
    await bot.handleUpdate(inGroup);
    await bot.handleUpdate(strangerCb);
    expect(passed).toEqual([inGroup.update_id, strangerCb.update_id]);
    expect(calls).toEqual([]);
    expect(host.logout).not.toHaveBeenCalled();
  });

  it('passes ordinary admin texts and other callbacks to the admin UI', async () => {
    const { bot, passed } = setup();
    const text = messageUpdate(ADMIN, 'salom');
    const otherCb = callbackUpdate(ADMIN, 'm');
    await bot.handleUpdate(text);
    await bot.handleUpdate(otherCb);
    expect(passed).toEqual([text.update_id, otherCb.update_id]);
  });

  it('shows the status with /userbot', async () => {
    const { bot, texts, passed } = setup();
    await bot.handleUpdate(messageUpdate(ADMIN, '/userbot'));
    expect(texts()[0]).toContain('Userbot ulanmagan');
    expect(passed).toEqual([]);
  });

  it('does not start a second login when already connected', async () => {
    const { bot, texts, host, setStatus } = setup();
    setStatus({ state: 'ready', userId: OWNER_ID, username: 'owner' });
    await bot.handleUpdate(messageUpdate(ADMIN, '/login'));
    expect(texts()[0]).toContain('@owner');
    expect(host.newLoginClient).not.toHaveBeenCalled();
  });

  it('runs QR login with a 2FA password that is deleted immediately and never echoed', async () => {
    const received: string[] = [];
    const { bot, calls, texts, host, passed } = setup(async (params) => {
      await params.qrCode?.({ token: Buffer.from('login-token'), expires: 0 });
      received.push(await params.password!('my hint'));
      return {};
    });
    await bot.handleUpdate(messageUpdate(ADMIN, '/login'));
    await vi.waitFor(() => expect(texts().some((t) => t.includes('🔑'))).toBe(true));

    const photo = calls.find((c) => c.method === 'sendPhoto')!;
    expect(String(photo.payload.caption)).toContain('Link Desktop Device');
    expect(texts().find((t) => t.includes('🔑'))).toContain('hint: my hint');

    const second = messageUpdate(ADMIN, '/login');
    await bot.handleUpdate(second);
    expect(texts().at(-1)).toContain('allaqachon jarayonda');

    const pwUpdate = messageUpdate(ADMIN, PASSWORD);
    await bot.handleUpdate(pwUpdate);
    expect(passed).not.toContain(pwUpdate.update_id);
    const deletion = calls.find((c) => c.method === 'deleteMessage' && c.payload.message_id === pwUpdate.message!.message_id);
    expect(deletion).toBeDefined();

    await vi.waitFor(() => expect(texts().some((t) => t.startsWith('✅ Userbot ulandi: @owner'))).toBe(true));
    expect(received).toEqual([PASSWORD]);
    expect(host.adopt).toHaveBeenCalledTimes(1);
    expect(host.discard).not.toHaveBeenCalled();
    // The QR message is removed, and the password never appears in anything sent to Telegram.
    const qrId = calls.findIndex((c) => c.method === 'sendPhoto');
    expect(qrId).toBeGreaterThanOrEqual(0);
    expect(calls.filter((c) => c.method === 'deleteMessage').length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(calls.map((c) => ({ m: c.method, t: c.payload.text, cap: c.payload.caption })))).not.toContain(PASSWORD);
  });

  it('cancels a pending login with /cancel_login', async () => {
    const { bot, texts, host, controller } = setup(async (params) => {
      await params.qrCode?.({ token: Buffer.from('t'), expires: 0 });
      return new Promise(() => undefined); // never scanned
    });
    await bot.handleUpdate(messageUpdate(ADMIN, '/login'));
    await vi.waitFor(() => expect(controller.inProgress).toBe(true));
    await bot.handleUpdate(messageUpdate(ADMIN, '/cancel_login'));
    expect(texts()).toContain('❎ Login bekor qilindi.');
    await vi.waitFor(() => expect(host.discard).toHaveBeenCalledTimes(1));
    expect(host.loginFailed).toHaveBeenCalled();
    expect(host.adopt).not.toHaveBeenCalled();
    expect(controller.inProgress).toBe(false);
  });

  it('asks for confirmation before /logout and logs out on the inline button', async () => {
    const { bot, calls, host, setStatus } = setup();
    setStatus({ state: 'ready', userId: OWNER_ID, username: 'owner' });
    await bot.handleUpdate(messageUpdate(ADMIN, '/logout'));
    const prompt = calls.find((c) => c.method === 'sendMessage')!;
    const markup = JSON.stringify(prompt.payload.reply_markup);
    expect(markup).toContain('ub.lo|y');
    expect(host.logout).not.toHaveBeenCalled();
    await bot.handleUpdate(callbackUpdate(ADMIN, 'ub.lo|y'));
    expect(host.logout).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.method === 'editMessageText' && String(c.payload.text).includes('chiqildi'))).toBe(true);
  });
});
