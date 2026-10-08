import type { Api, Context, MiddlewareFn } from 'grammy';
import type { Update } from 'grammy/types';
import type { Db } from '../database/client.js';
import type { Tenant } from '../generated/prisma/client.js';
import { childLogger } from '../logging/logger.js';
import { describeError } from '../logging/sanitize.js';
import { runAsSystem } from './context.js';
import type { TenantService } from './tenant.service.js';

const log = childLogger('tenancy');

/** The business connection an update belongs to (business_* updates only). */
function businessConnectionIdOf(update: Update): string | undefined {
  return (
    update.business_message?.business_connection_id ??
    update.edited_business_message?.business_connection_id ??
    update.deleted_business_messages?.business_connection_id
  );
}

/**
 * Finds the workspace a Telegram update belongs to:
 *  - business_connection: the connecting account (its owner must have an active workspace);
 *  - business_* messages: the stored connection's tenant (or the owner reported by Telegram);
 *  - messages / button presses in a private chat with the bot: the person writing.
 * Returns null when the update belongs to no active workspace (onboarding, strangers).
 */
export async function resolveUpdateTenant(deps: { db: Db; tenants: TenantService; api?: Api }, update: Update): Promise<Tenant | null> {
  if (update.business_connection) return deps.tenants.activeByTelegramUserId(BigInt(update.business_connection.user.id));

  const connectionId = businessConnectionIdOf(update);
  if (connectionId) {
    const stored = await runAsSystem(() =>
      deps.db.telegramConnection.findUnique({ where: { id: connectionId }, select: { tenantId: true } }),
    );
    if (stored) {
      const tenant = await deps.tenants.byId(stored.tenantId);
      return tenant?.status === 'ACTIVE' ? tenant : null;
    }
    if (!deps.api) return null;
    try {
      const bc = await deps.api.getBusinessConnection(connectionId);
      return deps.tenants.activeByTelegramUserId(BigInt(bc.user.id));
    } catch (error) {
      log.warn({ error: describeError(error) }, 'could not resolve the business connection owner');
      return null;
    }
  }

  const chat = update.message?.chat ?? update.callback_query?.message?.chat;
  const from = update.message?.from ?? update.callback_query?.from;
  if (from && (!chat || chat.type === 'private')) return deps.tenants.activeByTelegramUserId(BigInt(from.id));
  return null;
}

/**
 * Runs the rest of the middleware stack in the update's tenant scope. Updates without an active
 * workspace continue without a scope: only global tables are usable there (onboarding, rejections),
 * and any tenant-owned query fails closed.
 */
export function tenantScope(deps: { db: Db; tenants: TenantService; api?: Api }): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const tenant = await resolveUpdateTenant(deps, ctx.update);
    if (!tenant) return next();
    return deps.tenants.run(tenant, () => next());
  };
}
