import { Composer, type Context } from 'grammy';
import type { PresenceState, UserbotAssistantApi, UserbotRuntime, UserbotRuntimeDeps } from '../../app/userbot-contract.js';
import type { Tenant } from '../../generated/prisma/client.js';
import { childLogger } from '../../logging/logger.js';
import { describeError } from '../../logging/sanitize.js';
import type { DownloadedFile, DownloadOptions, FileDownloader } from '../../media/telegram-file.js';
import { currentTenantOrNull, runAsSystem } from '../../tenancy/context.js';
import type { TenantService } from '../../tenancy/tenant.service.js';
import type { UserbotTransport } from '../main/sender.js';

const log = childLogger('userbot-manager');

export type UserbotRuntimeBase = Omit<
  UserbotRuntimeDeps,
  'adminTelegramUserId' | 'onReady' | 'onLoggedOut' | 'onPresence' | 'runInScope' | 'envSession'
>;

export interface UserbotManagerDeps {
  base: UserbotRuntimeBase;
  /** TELEGRAM_SESSION from env: only ever used for the super-admin's workspace. */
  envSession?: string;
  superAdminId: bigint;
  tenants: TenantService;
  create: (deps: UserbotRuntimeDeps) => UserbotRuntime;
  setTransport: (ownerUserId: bigint, transport: UserbotTransport | null) => void;
  /** Presence pushes, delivered in the workspace's tenant scope. */
  onPresence?: (userId: bigint, state: PresenceState) => Promise<void>;
}

/**
 * One MTProto userbot per workspace. Each runtime is created on demand (/login, or at startup when a
 * stored session exists) and every event it produces runs in its workspace's tenant scope. The admin
 * commands (/login, /logout, /userbot), media downloads and assistant lookups are routed to the
 * runtime of the workspace the current update belongs to.
 */
export class UserbotManager {
  private readonly runtimes = new Map<number, UserbotRuntime>();
  private readonly owners = new Map<number, bigint>();
  readonly composer = new Composer<Context>();
  readonly downloader: FileDownloader;

  constructor(private readonly d: UserbotManagerDeps) {
    this.composer.use(async (ctx, next) => {
      const scope = currentTenantOrNull();
      if (!scope) return next();
      const tenant = await this.d.tenants.byId(scope.tenantId);
      if (!tenant || tenant.status !== 'ACTIVE') return next();
      return this.forTenant(tenant).composer.middleware()(ctx, next);
    });
    this.downloader = {
      download: (fileId: string, opts: DownloadOptions): Promise<DownloadedFile> => {
        const runtime = this.current();
        if (!runtime) return Promise.reject(new Error('userbot of this workspace is not connected; cannot download MTProto media'));
        return runtime.downloader.download(fileId, opts);
      },
    };
  }

  /** The runtime of the workspace the current unit of work belongs to (null when none exists). */
  current(): UserbotRuntime | null {
    const scope = currentTenantOrNull();
    return scope ? (this.runtimes.get(scope.tenantId) ?? null) : null;
  }

  /** Presence / username lookups for the current workspace's assistant. */
  assistantApi(): UserbotAssistantApi | null {
    return this.current()?.assistantApi ?? null;
  }

  forTenant(tenant: Tenant): UserbotRuntime {
    const existing = this.runtimes.get(tenant.id);
    if (existing) return existing;
    const owner = tenant.telegramUserId;
    // Fresh tenant row per event (cached briefly), so key/language changes reach running userbots.
    const scope = async <T>(fn: () => Promise<T>): Promise<T> => this.d.tenants.run((await this.d.tenants.byId(tenant.id)) ?? tenant, fn);
    const runtime = this.d.create({
      ...this.d.base,
      adminTelegramUserId: owner,
      ...(owner === this.d.superAdminId && this.d.envSession ? { envSession: this.d.envSession } : {}),
      onReady: (transport) => this.d.setTransport(owner, transport),
      onLoggedOut: () => this.d.setTransport(owner, null),
      onPresence: (userId, state) => {
        const handler = this.d.onPresence;
        if (handler) scope(() => handler(userId, state)).catch((error: unknown) => log.warn({ error: describeError(error) }, 'presence handler failed'));
      },
      runInScope: scope,
    });
    this.runtimes.set(tenant.id, runtime);
    this.owners.set(tenant.id, owner);
    return runtime;
  }

  /**
   * Starts the super-admin's userbot (it asks for /login when needed) and every active workspace
   * that already has a stored session; other workspaces start when their owner runs /login.
   */
  async startAll(): Promise<void> {
    const withSession = new Set(
      (await runAsSystem(() => this.d.base.db.userbotSession.findMany({ select: { tenantId: true } }))).map((r) => r.tenantId),
    );
    for (const tenant of await this.d.tenants.listActive()) {
      if (tenant.telegramUserId !== this.d.superAdminId && !withSession.has(tenant.id)) continue;
      const runtime = this.forTenant(tenant);
      await this.d.tenants.run(tenant, () => runtime.start()).catch((error: unknown) =>
        log.error({ tenantId: tenant.id, error: describeError(error) }, 'userbot start failed'),
      );
    }
  }

  /** Disconnects a workspace's userbot (access revoked). The stored session is kept. */
  async stop(tenantId: number): Promise<void> {
    const runtime = this.runtimes.get(tenantId);
    if (!runtime) return;
    this.runtimes.delete(tenantId);
    await runtime.stop().catch((error: unknown) => log.warn({ tenantId, error: describeError(error) }, 'userbot stop failed'));
    const owner = this.owners.get(tenantId);
    this.owners.delete(tenantId);
    if (owner !== undefined) this.d.setTransport(owner, null);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id)));
  }
}
