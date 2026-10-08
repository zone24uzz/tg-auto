import { Prisma } from '../generated/prisma/client.js';
import { currentScope, TenantContextMissingError } from './context.js';

/**
 * Tenant isolation for every Prisma query (defence in depth on top of explicit filters):
 *  - DIRECT models carry a `tenantId` column: reads/updates/deletes get `AND tenantId = <current>`,
 *    creates get `tenantId = <current>` (a different explicit value throws).
 *  - PARENT models (no column of their own) are filtered through their parent relation.
 *  - GLOBAL models (tenants, admin input state, update de-dupe, job queue) are never filtered.
 * In system scope (startup, queue recovery, retention, super-admin views) nothing is filtered.
 * Outside any scope, tenant-owned models throw — the code fails closed instead of mixing tenants.
 * Raw SQL is not covered: every $queryRaw/$executeRaw must filter by tenant itself.
 */
export const DIRECT_MODELS = new Set<string>([
  'UserbotSession',
  'TelegramConnection',
  'TelegramUser',
  'Chat',
  'Message',
  'AiResponse',
  'UsageStat',
  'UserRule',
  'Setting',
  'Prompt',
  'OwnerAttention',
  'AuditLog',
  'AssistantTask',
  'SystemEvent',
]);
export const PARENT_MODELS: Readonly<Record<string, string>> = {
  MessageVersion: 'message',
  Media: 'message',
  ConversationSummary: 'chat',
};
export const GLOBAL_MODELS = new Set<string>(['Tenant', 'AdminState', 'ProcessedUpdate', 'Job']);

const WHERE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
]);
const UPDATE_OPS = new Set(['update', 'updateMany', 'updateManyAndReturn', 'upsert']);

export class CrossTenantWriteError extends Error {
  constructor(model: string, operation: string) {
    super(`${model}.${operation}: tenantId does not match the current tenant`);
    this.name = 'CrossTenantWriteError';
  }
}

type Args = Record<string, unknown>;

function withAnd(where: unknown, filter: Args): Args {
  if (!where || typeof where !== 'object') return filter;
  const w = where as Args;
  const existing = w.AND === undefined ? [] : Array.isArray(w.AND) ? w.AND : [w.AND];
  return { ...w, AND: [...existing, filter] };
}

function stamp(model: string, operation: string, data: unknown, tenantId: number): unknown {
  if (!data || typeof data !== 'object') return data;
  const d = data as Args;
  if (d.tenantId !== undefined && d.tenantId !== tenantId) throw new CrossTenantWriteError(model, operation);
  return { ...d, tenantId };
}

/** Rewrites one query's args for the current scope (exported for unit tests). */
export function scopeArgs(model: string, operation: string, args: Args | undefined): Args | undefined {
  if (GLOBAL_MODELS.has(model)) return args;
  const direct = DIRECT_MODELS.has(model);
  const parent = PARENT_MODELS[model];
  // A new table must be classified above (tests/unit/tenancy.test.ts checks every model).
  if (!direct && !parent) throw new Error(`tenancy: model ${model} is not classified`);

  const scope = currentScope();
  if (scope?.kind === 'system') return args;
  if (!scope) throw new TenantContextMissingError(`${model}.${operation}`);
  const { tenantId } = scope;

  const next: Args = { ...(args ?? {}) };
  const filter: Args = direct ? { tenantId } : { [parent!]: { tenantId } };
  if (WHERE_OPS.has(operation)) next.where = withAnd(next.where, filter);
  if (!direct) return next;

  if (operation === 'create') next.data = stamp(model, operation, next.data, tenantId);
  if (operation === 'createMany' || operation === 'createManyAndReturn') {
    const rows = Array.isArray(next.data) ? next.data : [next.data];
    next.data = rows.map((row) => stamp(model, operation, row, tenantId));
  }
  if (operation === 'upsert') next.create = stamp(model, operation, next.create, tenantId);
  if (UPDATE_OPS.has(operation)) {
    const data = operation === 'upsert' ? next.update : next.data;
    if (data && typeof data === 'object' && (data as Args).tenantId !== undefined && (data as Args).tenantId !== tenantId)
      throw new CrossTenantWriteError(model, operation);
  }
  return next;
}

/** Prisma client extension applying `scopeArgs` to every model query. */
export const tenancyExtension = Prisma.defineExtension({
  name: 'tenancy',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        return query(scopeArgs(model, operation, args as Args | undefined) as typeof args);
      },
    },
  },
});
