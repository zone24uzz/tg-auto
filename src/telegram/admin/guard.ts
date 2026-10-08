import type { Context, MiddlewareFn } from 'grammy';
import { currentTenantOrNull } from '../../tenancy/context.js';

/** Neutral answer outside private chats / when onboarding is unavailable. */
export const NOT_FOR_YOU = 'Bu shaxsiy bot.';

export class NotAdminError extends Error {
  constructor() {
    super('not the admin');
    this.name = 'NotAdminError';
  }
}

/** True only for the configured owner writing in their private chat with the bot. */
export function isAdminContext(ctx: Context, adminId: bigint): boolean {
  const from = ctx.from;
  if (!from || from.is_bot) return false;
  if (BigInt(from.id) !== adminId) return false;
  const chat = ctx.chat;
  return chat?.type === 'private' && BigInt(chat.id) === adminId;
}

/** The owner of the workspace this update runs in (src/tenancy/bot-scope.ts), or null. */
export function currentOwnerId(): bigint | null {
  return currentTenantOrNull()?.ownerTelegramUserId ?? null;
}

/**
 * Re-verifies the workspace owner (defence in depth) and returns the id used for audit trails.
 * Every mutating admin action goes through this, even behind the guard middleware.
 */
export function requireAdmin(ctx: Context): bigint {
  const owner = currentOwnerId();
  if (owner === null || !isAdminContext(ctx, owner)) throw new NotAdminError();
  return owner;
}

function isStartCommand(text: string | undefined): boolean {
  return !!text && /^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text);
}

/**
 * First middleware of the admin composer (only `message` / `callback_query` updates reach it).
 * The owner of the current workspace gets the admin UI. Anyone else in a private chat goes to
 * `onStranger` (onboarding: /start → settings → access request); without it — or outside private
 * chats — callbacks are answered silently, messages ignored and `/start` gets a neutral line.
 * Nothing about other workspaces or their owners is ever revealed.
 */
export function adminGuard(onStranger?: (ctx: Context) => Promise<void>): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const owner = currentOwnerId();
    if (owner !== null && isAdminContext(ctx, owner)) return next();
    if (onStranger && ctx.chat?.type === 'private' && ctx.from && !ctx.from.is_bot) return onStranger(ctx);
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery().catch(() => undefined);
      return;
    }
    if (ctx.message && ctx.chat?.type === 'private' && isStartCommand(ctx.message.text)) {
      await ctx.reply(NOT_FOR_YOU).catch(() => undefined);
    }
  };
}
