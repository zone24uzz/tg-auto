import type { Context, MiddlewareFn } from 'grammy';
import type { Db } from '../../database/client.js';
import { isUniqueViolation } from '../../messages/message.repository.js';

/**
 * Update-level idempotency: each (bot, update_id) is processed at most once, even when
 * Telegram redelivers a webhook or polling restarts. If the handler throws, the claim is
 * released so a redelivery can be processed again.
 */
export function idempotency(db: Db, botKind: 'main' | 'admin'): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const updateId = BigInt(ctx.update.update_id);
    try {
      await db.processedUpdate.create({ data: { botKind, updateId } });
    } catch (error) {
      if (isUniqueViolation(error)) return;
      throw error;
    }
    try {
      await next();
    } catch (error) {
      await db.processedUpdate.delete({ where: { botKind_updateId: { botKind, updateId } } }).catch(() => undefined);
      throw error;
    }
  };
}
