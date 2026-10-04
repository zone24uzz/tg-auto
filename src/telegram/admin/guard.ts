import type { Context, MiddlewareFn } from 'grammy';

/** The only thing a stranger ever learns from this bot. */
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

/**
 * Re-verifies the admin (defence in depth) and returns the id used for audit trails.
 * Every mutating admin action goes through this, even behind the guard middleware.
 */
export function requireAdmin(ctx: Context, adminId: bigint): bigint {
  if (!isAdminContext(ctx, adminId)) throw new NotAdminError();
  return adminId;
}

function isStartCommand(text: string | undefined): boolean {
  return !!text && /^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text);
}

/**
 * First middleware of the admin composer (only `message` / `callback_query` updates reach it).
 * Non-admins: callbacks are answered silently, messages ignored, `/start` gets a neutral line.
 * Nothing about settings, the owner or the bot's purpose is ever revealed.
 */
export function adminGuard(adminId: bigint): MiddlewareFn<Context> {
  return async (ctx, next) => {
    if (isAdminContext(ctx, adminId)) return next();
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery().catch(() => undefined);
      return;
    }
    if (ctx.message && ctx.chat?.type === 'private' && isStartCommand(ctx.message.text)) {
      await ctx.reply(NOT_FOR_YOU).catch(() => undefined);
    }
  };
}
