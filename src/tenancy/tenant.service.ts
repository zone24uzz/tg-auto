import type { Db } from '../database/client.js';
import type { Tenant } from '../generated/prisma/client.js';
import { LANGS, runWithTenant, type Lang, type TenantScope } from './context.js';

const CACHE_TTL_MS = 30_000;

export function langOf(value: string | null | undefined): Lang {
  return (LANGS as readonly string[]).includes(value ?? '') ? (value as Lang) : 'uz';
}

export function scopeOf(tenant: Pick<Tenant, 'id' | 'telegramUserId' | 'language'> & Partial<Pick<Tenant, 'aiProvider' | 'aiApiKey'>>): Omit<TenantScope, 'kind'> {
  return {
    tenantId: tenant.id,
    ownerTelegramUserId: tenant.telegramUserId,
    language: langOf(tenant.language),
    ai: { provider: tenant.aiProvider ?? null, keyEnc: tenant.aiApiKey ?? null },
  };
}

/** Workspaces (the `tenants` table is global, so this works in any scope). */
export class TenantService {
  private readonly cache = new Map<string, { tenant: Tenant | null; at: number }>();

  constructor(private readonly db: Db) {}

  private cached(key: string): Tenant | null | undefined {
    const hit = this.cache.get(key);
    return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.tenant : undefined;
  }

  private remember(tenant: Tenant | null, ...keys: string[]): Tenant | null {
    for (const key of keys) this.cache.set(key, { tenant, at: Date.now() });
    return tenant;
  }

  invalidate(): void {
    this.cache.clear();
  }

  async byId(id: number): Promise<Tenant | null> {
    const hit = this.cached(`id:${id}`);
    if (hit !== undefined) return hit;
    const tenant = await this.db.tenant.findUnique({ where: { id } });
    return this.remember(tenant, `id:${id}`, ...(tenant ? [`tg:${tenant.telegramUserId}`] : []));
  }

  async byTelegramUserId(telegramUserId: bigint): Promise<Tenant | null> {
    const hit = this.cached(`tg:${telegramUserId}`);
    if (hit !== undefined) return hit;
    const tenant = await this.db.tenant.findUnique({ where: { telegramUserId } });
    return this.remember(tenant, `tg:${telegramUserId}`, ...(tenant ? [`id:${tenant.id}`] : []));
  }

  /** The active workspace owned by this Telegram user, or null. */
  async activeByTelegramUserId(telegramUserId: bigint): Promise<Tenant | null> {
    const tenant = await this.byTelegramUserId(telegramUserId);
    return tenant?.status === 'ACTIVE' ? tenant : null;
  }

  async listActive(): Promise<Tenant[]> {
    return this.db.tenant.findMany({ where: { status: 'ACTIVE' }, orderBy: { id: 'asc' } });
  }

  /** The super-admin (ADMIN_TELEGRAM_USER_ID) always has an active workspace. */
  async ensureSuperAdmin(telegramUserId: bigint): Promise<Tenant> {
    const tenant = await this.db.tenant.upsert({
      where: { telegramUserId },
      create: { telegramUserId, status: 'ACTIVE', approvedAt: new Date(), consentAt: new Date() },
      update: { status: 'ACTIVE' },
    });
    this.invalidate();
    return tenant;
  }

  /** Runs `fn` as this tenant's unit of work. */
  run<T>(tenant: Pick<Tenant, 'id' | 'telegramUserId' | 'language'> & Partial<Pick<Tenant, 'aiProvider' | 'aiApiKey'>>, fn: () => T): T {
    return runWithTenant(scopeOf(tenant), fn);
  }

  /** Runs `fn` for the tenant with this id; returns undefined (fn not called) when it does not exist. */
  async runById<T>(tenantId: number, fn: () => Promise<T>): Promise<T | undefined> {
    const tenant = await this.byId(tenantId);
    return tenant ? this.run(tenant, fn) : undefined;
  }
}
