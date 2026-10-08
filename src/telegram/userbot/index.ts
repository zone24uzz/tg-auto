import type { Composer, Context } from 'grammy';
import { Api } from 'telegram';
import type { UserbotAssistantApi, UserbotRuntime, UserbotRuntimeDeps, UserbotStatus } from '../../app/userbot-contract.js';
import { childLogger } from '../../logging/logger.js';
import { describeError, registerSecrets } from '../../logging/sanitize.js';
import type { NormalizedSender } from '../../messages/types.js';
import { escapeHtml } from '../common/html.js';
import { catchUpUnread } from './catch-up.js';
import { createAssistantApi, registerPresenceHandler } from './presence.js';
import { closeClient, createMtprotoClient, isAuthLostError, type ClientBundle } from './client.js';
import { MtprotoDownloader } from './downloader.js';
import { registerEventHandlers } from './events.js';
import { LoginController, accountLabel, createLoginComposer, type LoginHost } from './login.js';
import { toBigIntId } from './normalizer.js';
import { PeerResolver } from './peers.js';
import { SessionStore, type SessionSource } from './session-store.js';
import { MtprotoTransport } from './transport.js';

export { MTPROTO_FILE_PREFIX } from '../../app/userbot-contract.js';

const log = childLogger('userbot');

const LOGIN_REQUIRED_TEXT = '🔐 Userbot ulanmagan. Ulash uchun botga /login yuboring.';
/** Liveness probe of the MTProto connection; two failures in a row trigger a full reconnect. */
const HEALTH_CHECK_MS = 2 * 60_000;
const HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_FAILURES_BEFORE_RECONNECT = 2;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;

export function createUserbotRuntime(deps: UserbotRuntimeDeps): UserbotRuntime {
  return new UserbotRuntimeImpl(deps);
}

/** Owns the MTProto client: session restore, QR login, event wiring, health checks and shutdown. */
class UserbotRuntimeImpl implements UserbotRuntime, LoginHost<ClientBundle> {
  readonly composer: Composer<Context>;
  readonly downloader: MtprotoDownloader;
  readonly assistantApi: UserbotAssistantApi;
  readonly transport: MtprotoTransport;
  readonly apiId: number;
  readonly apiHash: string;
  readonly adminTelegramUserId: bigint;

  private state: UserbotStatus = { state: 'disconnected' };
  private bundle: ClientBundle | null = null;
  private source: SessionSource | 'login' | null = null;
  private unregister: (() => void) | null = null;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;
  private healthFailures = 0;
  private starting = false;
  private stopped = false;
  private readonly store: SessionStore;
  private readonly login: LoginController<ClientBundle>;

  constructor(private readonly deps: UserbotRuntimeDeps) {
    registerSecrets([deps.apiHash, deps.envSession]);
    this.apiId = deps.apiId;
    this.apiHash = deps.apiHash;
    this.adminTelegramUserId = deps.adminTelegramUserId;
    this.store = new SessionStore(deps.db, deps.cipher, deps.envSession);
    const peers = new PeerResolver(async (userId) => {
      const row = await deps.db.telegramUser.findFirst({ where: { telegramUserId: userId }, select: { accessHash: true } });
      return row?.accessHash ?? null;
    });
    const getClient = () => (this.state.state === 'ready' ? (this.bundle?.client ?? null) : null);
    this.transport = new MtprotoTransport({ getClient, peers, onAuthLost: (error) => void this.authLost(error) });
    this.downloader = new MtprotoDownloader(getClient, peers, deps.tmpDir);
    this.assistantApi = createAssistantApi(getClient);
    this.login = new LoginController<ClientBundle>(this);
    this.composer = createLoginComposer(this, this.login);
  }

  status(): UserbotStatus {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.starting || this.state.state === 'ready' || this.login.inProgress) return;
    this.starting = true;
    this.stopped = false;
    this.clearRetry();
    this.state = { state: 'connecting' };
    try {
      const { sessions, dbUnreadable } = await this.store.candidates();
      if (dbUnreadable) await this.deps.events.warn('userbot', 'stored session cannot be decrypted (DATA_ENCRYPTION_KEY changed?)');
      let connectError: unknown = null;
      for (const candidate of sessions) {
        if (this.stopped) return;
        const bundle = createMtprotoClient(candidate.session, this.apiId, this.apiHash, this.deps.mtproto);
        try {
          await bundle.client.connect();
          if (!(await bundle.client.checkAuthorization())) {
            await closeClient(bundle.client);
            await this.deps.events.warn('userbot', `${candidate.source} session is not authorized`);
            if (candidate.source === 'env') await this.deps.notifier.text('⚠️ .env dagi TELEGRAM_SESSION yaroqsiz (akkauntdan chiqarilgan).');
            continue;
          }
          const me = await bundle.client.getMe();
          if (this.stopped) {
            await closeClient(bundle.client);
            return;
          }
          await this.activate(bundle, me, candidate.source);
          this.retries = 0;
          return;
        } catch (error) {
          connectError = error;
          await closeClient(bundle.client);
          await this.deps.events.error('userbot', `connect failed (${candidate.source} session): ${describeError(error)}`);
        }
      }
      if (connectError !== null) {
        this.state = { state: 'error', message: describeError(connectError, 200) };
        if (this.retries === 0)
          await this.deps.notifier.text(`⚠️ Userbot Telegramga ulana olmadi: ${escapeHtml(describeError(connectError, 200))}. Qayta urinib ko‘riladi.`);
        this.scheduleRetry();
        return;
      }
      this.state = { state: 'login_required' };
      await this.deps.notifier.text(LOGIN_REQUIRED_TEXT);
    } catch (error) {
      this.state = { state: 'error', message: describeError(error, 200) };
      log.error({ error: describeError(error) }, 'userbot start failed');
      await this.deps.events.error('userbot', `start failed: ${describeError(error)}`);
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearRetry();
    this.login.cancel('shutdown');
    const bundle = this.detach();
    if (bundle) await closeClient(bundle.client);
    this.state = { state: 'disconnected' };
  }

  // ── LoginHost ──────────────────────────────────────────────────────────

  newLoginClient(): ClientBundle {
    return createMtprotoClient('', this.apiId, this.apiHash, this.deps.mtproto);
  }

  async adopt(bundle: ClientBundle, me: Api.User): Promise<{ sessionSaved: boolean }> {
    const meId = toBigIntId(me.id);
    if (meId === undefined) throw new Error('Telegram returned an account without id');
    let sessionSaved = false;
    try {
      sessionSaved = await this.store.save(bundle.session.save(), meId);
    } catch (error) {
      await this.deps.events.error('userbot', `could not store the session: ${describeError(error)}`);
    }
    await this.activate(bundle, me, 'login');
    return { sessionSaved };
  }

  async discard(bundle: ClientBundle): Promise<void> {
    await closeClient(bundle.client);
  }

  loginFailed(): void {
    if (this.state.state !== 'ready' && this.state.state !== 'connecting') this.state = { state: 'login_required' };
  }

  async logout(): Promise<void> {
    const bundle = this.detach();
    if (bundle) {
      try {
        await bundle.client.invoke(new Api.auth.LogOut());
      } catch (error) {
        log.warn({ error: describeError(error) }, 'auth.LogOut failed');
      }
      await closeClient(bundle.client);
    }
    await this.store.clear();
    this.state = { state: 'login_required' };
    this.deps.onLoggedOut();
    await this.deps.events.info('userbot', 'logged out by the owner');
    if (this.deps.envSession && this.source !== 'env')
      await this.deps.notifier.text('ℹ️ .env faylida TELEGRAM_SESSION bor — qayta ishga tushirilganda u ishlatiladi. Kerak bo‘lmasa, uni .env dan o‘chiring.');
    this.source = null;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async activate(bundle: ClientBundle, me: Api.User, source: SessionSource | 'login'): Promise<void> {
    const meId = toBigIntId(me.id);
    if (meId === undefined) throw new Error('Telegram returned an account without id');
    this.clearRetry();
    const previous = this.detach();
    if (previous && previous !== bundle) await closeClient(previous.client);

    const owner: NormalizedSender = {
      telegramUserId: meId,
      username: me.username,
      firstName: me.firstName,
      lastName: me.lastName,
      isBot: false,
    };
    await this.deps.connections.ensureUserbotConnection(meId);
    this.bundle = bundle;
    this.source = source;
    // MTProto events arrive outside any request: run each one in this workspace's tenant scope.
    const scope = this.deps.runInScope ?? (<T>(fn: () => Promise<T>) => fn());
    const business = this.deps.business;
    const eventContext = {
      client: bundle.client,
      connectionId: `userbot:${meId}`,
      owner: { id: meId, sender: owner },
      business: {
        handleIncoming: (msg: Parameters<typeof business.handleIncoming>[0]) => scope(() => business.handleIncoming(msg)),
        handleEdit: (msg: Parameters<typeof business.handleEdit>[0]) => scope(() => business.handleEdit(msg)),
        handleDeletedIds: (connectionId: string, ids: number[]) => scope(() => business.handleDeletedIds(connectionId, ids)),
      },
      transport: this.transport,
    };
    const unregisterEvents = registerEventHandlers(eventContext);
    const onPresence = this.deps.onPresence;
    const unregisterPresence = onPresence ? registerPresenceHandler(bundle.client, onPresence) : () => undefined;
    this.unregister = () => {
      unregisterEvents();
      unregisterPresence();
    };
    this.state = { state: 'ready', userId: meId, username: me.username };
    this.deps.onReady(this.transport);
    this.healthFailures = 0;
    this.startHealthCheck();
    // Answer messages that arrived while the client was offline (restart, network outage, sleep).
    void catchUpUnread(eventContext)
      .then(async (count) => {
        if (count > 0) await this.deps.events.info('userbot', `caught up ${count} unread message(s) after connecting`);
      })
      .catch((error: unknown) => log.warn({ error: describeError(error) }, 'userbot catch-up failed'));
    log.info({ source }, 'userbot connected');
    await this.deps.events.info('userbot', `connected as account ${meId} (${source} session)`);
    // The login flow tells the owner itself; on startup the admin is warned here.
    if (source !== 'login' && meId !== this.adminTelegramUserId)
      await this.deps.notifier.text(
        `⚠️ Userbot ${escapeHtml(accountLabel(me))} (id ${meId}) akkauntiga ulandi, lekin bu ish maydonining egasi — id ${this.adminTelegramUserId}. ` +
          'Xabarlar e’tiborsiz qoldiriladi: /logout qiling va o‘z akkauntingiz bilan /login qiling.',
      );
  }

  /** Unsubscribes handlers and detaches the client (returned so the caller can close it). */
  private detach(): ClientBundle | null {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
    try {
      this.unregister?.();
    } catch (error) {
      log.debug({ error: describeError(error) }, 'could not remove event handlers');
    }
    this.unregister = null;
    const bundle = this.bundle;
    this.bundle = null;
    return bundle;
  }

  private startHealthCheck(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => void this.healthCheck(), HEALTH_CHECK_MS);
    this.healthTimer.unref?.();
  }

  /** Detects sessions terminated from another device (Settings → Devices) or revoked by Telegram. */
  private async healthCheck(): Promise<void> {
    const client = this.bundle?.client;
    if (!client || this.state.state !== 'ready') return;
    try {
      await withTimeout(client.invoke(new Api.updates.GetState()), HEALTH_TIMEOUT_MS);
      this.healthFailures = 0;
    } catch (error) {
      if (isAuthLostError(error)) {
        await this.authLost(error);
        return;
      }
      this.healthFailures++;
      log.warn({ error: describeError(error), failures: this.healthFailures }, 'userbot health check failed');
      // GramJS' own reconnect can get stuck after a network outage or sleep: rebuild the client.
      if (this.healthFailures >= HEALTH_FAILURES_BEFORE_RECONNECT) await this.reconnect(describeError(error, 200));
    }
  }

  /** Drops the current client and connects again with the stored session (catch-up runs on success). */
  private async reconnect(reason: string): Promise<void> {
    if (this.state.state !== 'ready' || this.stopped) return;
    this.healthFailures = 0;
    const bundle = this.detach();
    this.state = { state: 'connecting' };
    if (bundle) await closeClient(bundle.client);
    log.warn({ reason }, 'userbot connection lost; reconnecting');
    await this.deps.events.warn('userbot', `connection lost (${reason}); reconnecting`);
    this.retries = 0;
    await this.start();
  }

  private async authLost(error: unknown): Promise<void> {
    if (this.state.state !== 'ready') return;
    const bundle = this.detach();
    this.state = { state: 'login_required' };
    this.deps.onLoggedOut();
    if (bundle) await closeClient(bundle.client);
    if (this.source === 'db' || this.source === 'login') await this.store.clear().catch(() => undefined);
    this.source = null;
    const reason = describeError(error, 200);
    log.warn({ error: reason }, 'userbot session is no longer valid');
    await this.deps.events.warn('userbot', `session lost: ${reason}`);
    await this.deps.notifier.text(`🔐 Userbot sessiyasi bekor qilindi (${escapeHtml(reason)}). Qayta ulash uchun botga /login yuboring.`);
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.retries);
    this.retries++;
    this.retryTimer = setTimeout(() => void this.start(), delay);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}
