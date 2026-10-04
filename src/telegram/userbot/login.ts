import { Composer, InlineKeyboard, InputFile, type Api as BotApi, type Context } from 'grammy';
import QRCode from 'qrcode';
import type { Api } from 'telegram';
import type { QrCodeAuthParams } from 'telegram/client/auth.js';
import { RPCError } from 'telegram/errors/index.js';
import type { UserbotStatus } from '../../app/userbot-contract.js';
import { childLogger } from '../../logging/logger.js';
import { describeError } from '../../logging/sanitize.js';
import { cb, parseCb } from '../admin/callback-data.js';
import { isAdminContext } from '../admin/guard.js';

const log = childLogger('userbot-login');

export const QR_PHASE_TIMEOUT_MS = 5 * 60_000;
export const PASSWORD_TIMEOUT_MS = 5 * 60_000;
const MAX_PASSWORD_ATTEMPTS = 3;
const LOGOUT_ROUTE = 'ub.lo';

const QR_CAPTION =
  '📱 Telefoningizda: Sozlamalar → Qurilmalar → «Kompyuterni ulash» (Link Desktop Device) → shu QR kodni skanerlang. ' +
  'Kod har ~30 soniyada yangilanadi. Bekor qilish: /cancel_login';

/** The part of the GramJS client the login flow uses (TelegramClient satisfies it). */
export interface LoginClient {
  connect(): Promise<unknown>;
  signInUserWithQrCode(credentials: { apiId: number; apiHash: string }, params: QrCodeAuthParams): Promise<unknown>;
  getMe(): Promise<Api.User>;
}

export interface LoginBundle {
  client: LoginClient;
}

/** Implemented by the userbot runtime (index.ts). */
export interface LoginHost<B extends LoginBundle> {
  readonly apiId: number;
  readonly apiHash: string;
  readonly adminTelegramUserId: bigint;
  status(): UserbotStatus;
  /** A fresh, unconnected client with an empty session. */
  newLoginClient(): B;
  /** Takes over a freshly authorized client: stores the session, registers handlers, attaches the transport. */
  adopt(bundle: B, me: Api.User): Promise<{ sessionSaved: boolean }>;
  /** Disconnects a client that will not be used. */
  discard(bundle: B): Promise<void>;
  loginFailed(): void;
  logout(): Promise<void>;
}

type Failure = 'user' | 'shutdown' | 'connect_timeout' | 'qr_timeout' | 'password_timeout' | 'password_attempts';

/** Connecting to Telegram must never leave a login hanging (a blocked network would otherwise wait forever). */
export const CONNECT_TIMEOUT_MS = 30_000;

class LoginCancelledError extends Error {
  constructor(readonly reason: Failure) {
    super(`login cancelled (${reason})`);
    this.name = 'LoginCancelledError';
  }
}

type Command = 'login' | 'cancel_login' | 'logout' | 'userbot';
const COMMANDS: readonly string[] = ['login', 'cancel_login', 'logout', 'userbot'];

export function parseCommand(text: string, botUsername: string | undefined): Command | null {
  const m = /^\/([a-z_]+)(?:@([A-Za-z0-9_]+))?(?:\s|$)/.exec(text);
  if (!m || !COMMANDS.includes(m[1]!)) return null;
  if (m[2] && m[2].toLowerCase() !== (botUsername ?? '').toLowerCase()) return null;
  return m[1] as Command;
}

export function accountLabel(u: { username?: string; firstName?: string; lastName?: string }): string {
  if (u.username) return `@${u.username}`;
  return [u.firstName, u.lastName].filter(Boolean).join(' ') || 'noma’lum';
}

function timer(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return t;
}

/** State of one /login attempt (QR → optional 2FA password → adopt). */
class LoginAttempt<B extends LoginBundle> {
  cancelled = false;
  failure: Failure | undefined;
  qrMessageId: number | undefined;
  passwordAttempts = 0;
  lastPasswordWrong = false;
  waiter: { resolve: (password: string) => void; reject: (error: Error) => void } | null = null;
  qrTimer: ReturnType<typeof setTimeout> | undefined;
  readonly cancellation: Promise<never>;
  private rejectCancellation: (error: Error) => void = () => undefined;

  constructor(
    readonly bundle: B,
    readonly api: BotApi,
    readonly chatId: number,
  ) {
    this.cancellation = new Promise<never>((_, reject) => {
      this.rejectCancellation = reject;
    });
    this.cancellation.catch(() => undefined);
  }

  cancel(reason: Failure): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.failure = reason;
    const error = new LoginCancelledError(reason);
    this.waiter?.reject(error);
    this.waiter = null;
    this.rejectCancellation(error);
  }

  race<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, this.cancellation]);
  }

  async say(text: string): Promise<void> {
    await this.api.sendMessage(this.chatId, text).catch((error: unknown) => log.warn({ error: describeError(error) }, 'login message failed'));
  }

  async deleteQr(): Promise<void> {
    if (this.qrMessageId === undefined) return;
    const id = this.qrMessageId;
    this.qrMessageId = undefined;
    await this.api.deleteMessage(this.chatId, id).catch(() => undefined);
  }
}

function friendlyError(attempt: { failure: Failure | undefined }, error: unknown): string {
  const retry = 'Qayta urinish: /login';
  switch (attempt.failure) {
    case 'connect_timeout':
      return `🌐 Telegram serveriga 30 soniyada ulanib bo‘lmadi (tarmoq MTProto ulanishini to‘sayotgan bo‘lishi mumkin). ${retry}`;
    case 'qr_timeout':
      return `⌛ QR kod 5 daqiqa ichida skanerlanmadi. Login bekor qilindi. ${retry}`;
    case 'password_timeout':
      return `⌛ Parol 5 daqiqa ichida yuborilmadi. Login bekor qilindi. ${retry}`;
    case 'password_attempts':
      return `❌ Parol ${MAX_PASSWORD_ATTEMPTS} marta noto‘g‘ri kiritildi. Login bekor qilindi. ${retry}`;
    default:
      break;
  }
  if (error instanceof RPCError) {
    if (/^API_ID_/.test(error.errorMessage)) return `❌ Telegram api_id/api_hash ni rad etdi (${error.errorMessage}). TELEGRAM_API_ID va TELEGRAM_API_HASH ni tekshiring.`;
    return `❌ Telegram loginni rad etdi (${error.errorMessage}). ${retry}`;
  }
  return `❌ Login amalga oshmadi: ${describeError(error, 200)}. ${retry}`;
}

export function statusText(st: UserbotStatus, adminId: bigint, loginInProgress: boolean): string {
  const lines: string[] = [];
  switch (st.state) {
    case 'ready':
      lines.push(`🟢 Userbot ulangan: ${st.username ? `@${st.username}` : 'akkaunt'} (id ${st.userId})`);
      if (st.userId !== adminId) lines.push(`⚠️ Bu akkaunt ADMIN_TELEGRAM_USER_ID (${adminId}) emas — xabarlar e’tiborsiz qoldiriladi.`);
      break;
    case 'connecting':
      lines.push('⏳ Userbot Telegramga ulanmoqda…');
      break;
    case 'error':
      lines.push(`🔴 Userbot xatosi: ${st.message.slice(0, 300)}`, 'Qayta urinish: /login');
      break;
    case 'login_required':
      lines.push('🔐 Userbot ulanmagan. Ulash: /login');
      break;
    default:
      lines.push('⚪️ Userbot o‘chiq.');
  }
  if (loginInProgress) lines.push('⏳ Login jarayonda. Bekor qilish: /cancel_login');
  return lines.join('\n');
}

/** QR-code login (+ optional 2FA) driven from the owner's private chat with the admin bot. */
export class LoginController<B extends LoginBundle> {
  private active: LoginAttempt<B> | null = null;

  constructor(private readonly host: LoginHost<B>) {}

  get inProgress(): boolean {
    return this.active !== null;
  }

  get awaitingPassword(): boolean {
    return this.active?.waiter != null;
  }

  async start(ctx: Context): Promise<void> {
    const st = this.host.status();
    if (st.state === 'ready') {
      await ctx.reply(`✅ Userbot allaqachon ulangan: ${st.username ? `@${st.username}` : 'akkaunt'} (id ${st.userId}).\nBoshqa akkaunt uchun avval /logout.`);
      return;
    }
    if (st.state === 'connecting') {
      await ctx.reply('⏳ Userbot hozir ulanmoqda, biroz kuting va /userbot bilan holatni tekshiring.');
      return;
    }
    if (this.active) {
      await ctx.reply('⏳ Login allaqachon jarayonda. Bekor qilish: /cancel_login');
      return;
    }
    const attempt = new LoginAttempt(this.host.newLoginClient(), ctx.api, ctx.chat!.id);
    this.active = attempt;
    // Runs in the background: grammY handles updates one by one, and the password arrives as a later update.
    void this.run(attempt).catch((error: unknown) => log.error({ error: describeError(error) }, 'login flow crashed'));
  }

  /** Returns false when no login was running. */
  cancel(reason: Failure): boolean {
    if (!this.active) return false;
    this.active.cancel(reason);
    return true;
  }

  /** The owner's 2FA password: delete the message immediately, never log or store it. */
  async acceptPassword(ctx: Context, password: string): Promise<void> {
    const waiter = this.active?.waiter;
    if (!waiter) return;
    let deleted = true;
    await ctx.deleteMessage().catch(() => {
      deleted = false;
    });
    waiter.resolve(password);
    await ctx.reply(deleted ? '⏳ Parol tekshirilmoqda…' : '⏳ Parol tekshirilmoqda… ⚠️ Xabaringizni o‘chirib bo‘lmadi — uni qo‘lda o‘chiring.');
  }

  private async run(attempt: LoginAttempt<B>): Promise<void> {
    const { client } = attempt.bundle;
    let adopted = false;
    try {
      const connectTimer = timer(CONNECT_TIMEOUT_MS, () => attempt.cancel('connect_timeout'));
      try {
        await attempt.race(client.connect());
      } finally {
        clearTimeout(connectTimer);
      }
      attempt.qrTimer = timer(QR_PHASE_TIMEOUT_MS, () => attempt.cancel('qr_timeout'));
      const signIn = client.signInUserWithQrCode(
        { apiId: this.host.apiId, apiHash: this.host.apiHash },
        {
          qrCode: async ({ token }) => {
            if (attempt.cancelled) throw new LoginCancelledError(attempt.failure ?? 'user');
            await this.showQr(attempt, token);
          },
          password: (hint?: string) => this.askPassword(attempt, hint),
          onError: async (error: Error) => this.onAuthError(attempt, error),
        },
      );
      signIn.catch(() => undefined); // we may stop waiting for it (cancel/timeout)
      await attempt.race(signIn);
      clearTimeout(attempt.qrTimer);
      const me = await attempt.race(client.getMe());
      const { sessionSaved } = await this.host.adopt(attempt.bundle, me);
      adopted = true;
      const lines = [`✅ Userbot ulandi: ${accountLabel(me)} (id ${String(me.id)})`];
      if (String(me.id) !== this.host.adminTelegramUserId.toString())
        lines.push(`⚠️ Bu akkaunt ADMIN_TELEGRAM_USER_ID (${this.host.adminTelegramUserId}) emas — xabarlar e’tiborsiz qoldiriladi, toki ADMIN_TELEGRAM_USER_ID shu akkauntga mos kelmaguncha.`);
      if (!sessionSaved) lines.push('⚠️ DATA_ENCRYPTION_KEY o‘rnatilmagan: sessiya bazaga saqlanmadi, qayta ishga tushirilgandan keyin yana /login kerak bo‘ladi.');
      await attempt.say(lines.join('\n'));
    } catch (error) {
      if (attempt.failure !== 'user' && attempt.failure !== 'shutdown') {
        log.warn({ error: describeError(error), reason: attempt.failure }, 'userbot login failed');
        await attempt.say(friendlyError(attempt, error));
      }
      this.host.loginFailed();
    } finally {
      clearTimeout(attempt.qrTimer);
      attempt.cancel('shutdown'); // settles any pending waiter; no-op when already cancelled
      await attempt.deleteQr();
      if (!adopted) await this.host.discard(attempt.bundle);
      if (this.active === attempt) this.active = null;
    }
  }

  private async showQr(attempt: LoginAttempt<B>, token: Buffer): Promise<void> {
    const png = await QRCode.toBuffer(`tg://login?token=${token.toString('base64url')}`, {
      type: 'png',
      width: 480,
      margin: 2,
      errorCorrectionLevel: 'M',
    });
    const photo = new InputFile(png, 'login-qr.png');
    if (attempt.qrMessageId !== undefined) {
      try {
        await attempt.api.editMessageMedia(attempt.chatId, attempt.qrMessageId, { type: 'photo', media: photo, caption: QR_CAPTION });
        return;
      } catch (error) {
        log.debug({ error: describeError(error) }, 'could not refresh the QR message; sending a new one');
        await attempt.deleteQr();
      }
    }
    const sent = await attempt.api.sendPhoto(attempt.chatId, new InputFile(png, 'login-qr.png'), { caption: QR_CAPTION });
    attempt.qrMessageId = sent.message_id;
  }

  private askPassword(attempt: LoginAttempt<B>, hint: string | undefined): Promise<string> {
    if (attempt.cancelled) return Promise.reject(new LoginCancelledError(attempt.failure ?? 'user'));
    clearTimeout(attempt.qrTimer); // the QR code was scanned
    void attempt.deleteQr();
    attempt.passwordAttempts++;
    return new Promise<string>((resolve, reject) => {
      const t = timer(PASSWORD_TIMEOUT_MS, () => attempt.cancel('password_timeout'));
      attempt.waiter = {
        resolve: (password) => {
          clearTimeout(t);
          attempt.waiter = null;
          resolve(password);
        },
        reject: (error) => {
          clearTimeout(t);
          attempt.waiter = null;
          reject(error);
        },
      };
      const prefix = attempt.lastPasswordWrong ? '❌ Parol noto‘g‘ri. ' : '';
      const cleanHint = hint?.trim().slice(0, 100);
      void attempt.say(
        `${prefix}🔑 Akkauntingizda 2 bosqichli parol bor. Parolni yuboring${cleanHint ? ` (hint: ${cleanHint})` : ''}. ` +
          'Xabaringiz darhol o‘chiriladi. Bekor qilish: /cancel_login',
      );
    });
  }

  /** GramJS asks whether to stop after an auth error; true stops the flow. */
  private onAuthError(attempt: LoginAttempt<B>, error: Error): boolean {
    if (attempt.cancelled) return true;
    if (error instanceof RPCError && error.errorMessage === 'PASSWORD_HASH_INVALID') {
      if (attempt.passwordAttempts >= MAX_PASSWORD_ATTEMPTS) {
        attempt.failure = 'password_attempts';
        return true;
      }
      attempt.lastPasswordWrong = true;
      return false; // GramJS asks for the password again
    }
    return true;
  }
}

/**
 * Admin-only commands: /login, /cancel_login, /logout (with confirmation), /userbot.
 * Anything else — and every update from someone other than the owner — goes to next() untouched.
 */
export function createLoginComposer<B extends LoginBundle>(host: LoginHost<B>, controller: LoginController<B>): Composer<Context> {
  const composer = new Composer<Context>();
  composer.use(async (ctx, next) => {
    if (!isAdminContext(ctx, host.adminTelegramUserId)) return next();

    const data = ctx.callbackQuery?.data;
    if (data !== undefined) {
      const { route, args } = parseCb(data);
      if (route !== LOGOUT_ROUTE) return next();
      await ctx.answerCallbackQuery().catch(() => undefined);
      if (args[0] !== 'y') {
        await ctx.editMessageText('Bekor qilindi.').catch(() => undefined);
        return;
      }
      await ctx.editMessageText('⏳ Userbot sessiyasidan chiqilmoqda…').catch(() => undefined);
      try {
        await host.logout();
        await ctx.editMessageText('✅ Userbot sessiyasidan chiqildi. Avtojavoblar to‘xtadi. Qayta ulash: /login').catch(() => undefined);
      } catch (error) {
        await ctx.editMessageText(`❌ Chiqishda xato: ${describeError(error, 200)}`).catch(() => undefined);
      }
      return;
    }

    const text = ctx.message?.text;
    if (text === undefined) return next();
    const command = parseCommand(text, ctx.me.username);
    if (command === null) {
      if (controller.awaitingPassword) return controller.acceptPassword(ctx, text);
      return next();
    }
    switch (command) {
      case 'login':
        return controller.start(ctx);
      case 'cancel_login':
        await ctx.reply(controller.cancel('user') ? '❎ Login bekor qilindi.' : 'Hozir login jarayoni yo‘q.');
        return;
      case 'userbot':
        await ctx.reply(statusText(host.status(), host.adminTelegramUserId, controller.inProgress));
        return;
      case 'logout': {
        const st = host.status();
        if (st.state !== 'ready' && st.state !== 'error') {
          await ctx.reply('Userbot ulanmagan — chiqish shart emas. Ulash: /login');
          return;
        }
        const keyboard = new InlineKeyboard().text('✅ Ha, chiqish', cb(LOGOUT_ROUTE, 'y')).text('❌ Yo‘q', cb(LOGOUT_ROUTE, 'n'));
        await ctx.reply('⚠️ Userbot sessiyasidan chiqilsinmi? Avtojavoblar to‘xtaydi, qayta ulash uchun /login kerak bo‘ladi.', {
          reply_markup: keyboard,
        });
        return;
      }
    }
  });
  return composer;
}
