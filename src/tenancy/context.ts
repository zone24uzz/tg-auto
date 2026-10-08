import { AsyncLocalStorage } from 'node:async_hooks';

export type Lang = 'uz' | 'ru' | 'en';
export const LANGS: readonly Lang[] = ['uz', 'ru', 'en'];

/** The workspace the current unit of work (update, job, tick) belongs to. */
export interface TenantScope {
  kind: 'tenant';
  tenantId: number;
  /** The tenant owner's Telegram user id: their admin chat and their account. */
  ownerTelegramUserId: bigint;
  language: Lang;
  /** The workspace's own AI provider and API key (ContentCipher ciphertext; decrypted only when used). */
  ai?: { provider: string | null; keyEnc: string | null };
}

/** Explicitly cross-tenant work (startup, queue recovery, retention sweeps, super-admin views). */
export interface SystemScope {
  kind: 'system';
}

export type Scope = TenantScope | SystemScope;

export class TenantContextMissingError extends Error {
  constructor(what: string) {
    super(`no tenant context for ${what} (wrap the entry point in runWithTenant/runAsSystem)`);
    this.name = 'TenantContextMissingError';
  }
}

const storage = new AsyncLocalStorage<Scope>();
let testFallback: Scope | undefined;

/**
 * Runs `fn` inside `scope`. Prisma queries are LAZY thenables: `runAsSystem(() => db.x.findMany())`
 * only builds the query, which would otherwise execute — and be tenant-scoped — wherever it is awaited
 * later, outside this scope. Any thenable result is therefore started here, while the scope is active.
 */
function runIn<T>(scope: Scope, fn: () => T): T {
  return storage.run(scope, () => {
    const result = fn();
    if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
      return (result as unknown as PromiseLike<unknown>).then((value) => value) as unknown as T;
    }
    return result;
  });
}

export function runWithTenant<T>(tenant: Omit<TenantScope, 'kind'>, fn: () => T): T {
  return runIn({ kind: 'tenant', ...tenant }, fn);
}

export function runAsSystem<T>(fn: () => T): T {
  return runIn({ kind: 'system' }, fn);
}

/**
 * Scripts only (CLI tools that call services directly): makes `scope` the active scope for the rest
 * of the current async flow. Request/job code must use runWithTenant / runAsSystem instead.
 */
export function enterScope(scope: Scope): void {
  storage.enterWith(scope);
}

/** The active scope, or undefined outside any entry point. */
export function currentScope(): Scope | undefined {
  return storage.getStore() ?? testFallback;
}

/** The active tenant, or null in system scope / no scope. */
export function currentTenantOrNull(): TenantScope | null {
  const scope = currentScope();
  return scope?.kind === 'tenant' ? scope : null;
}

/** The active tenant; throws when the code runs outside a tenant's unit of work. */
export function currentTenant(what = 'this operation'): TenantScope {
  const tenant = currentTenantOrNull();
  if (!tenant) throw new TenantContextMissingError(what);
  return tenant;
}

/** Shortcut for `currentTenant(what).tenantId` (compound unique keys need the value explicitly). */
export function currentTenantId(what?: string): number {
  return currentTenant(what).tenantId;
}

/**
 * Tests only: a scope used when no entry point established one (services are called directly in
 * tests). Ignored outside vitest so production can never fall back to a default tenant.
 */
export function setTestFallbackScope(scope: Scope | undefined): void {
  if (!process.env.VITEST) throw new Error('setTestFallbackScope is only available in tests');
  testFallback = scope;
}
