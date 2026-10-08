import { autoRetry } from '@grammyjs/auto-retry';
import { Bot, type Composer, type Context } from 'grammy';
import type { Db } from '../../database/client.js';
import { childLogger } from '../../logging/logger.js';
import { describeError } from '../../logging/sanitize.js';
import { tenantScope } from '../../tenancy/bot-scope.js';
import { currentTenantOrNull } from '../../tenancy/context.js';
import type { TenantService } from '../../tenancy/tenant.service.js';
import { idempotency } from '../common/update-guard.js';
import type { BusinessHandlers } from './business.handlers.js';
import type { ConnectionService } from './connection.service.js';

const log = childLogger('main-bot');

export const MAIN_ALLOWED_UPDATES = [
  'message',
  'callback_query',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
] as const;

export const ADMIN_ALLOWED_UPDATES = ['message', 'callback_query'] as const;

export function createBot(token: string, apiRoot: string): Bot {
  const bot = new Bot(token, { client: { apiRoot } });
  // Respect Telegram 429 retry_after and transient 5xx errors on every API call.
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30, rethrowInternalServerErrors: false }));
  return bot;
}

/**
 * Wires Telegram Business updates (and, in single-bot mode, the admin UI) onto the main bot.
 * Business handlers only store + enqueue, so polling stays fast even though grammY
 * processes updates sequentially.
 */
export function configureMainBot(p: {
  bot: Bot;
  db: Db;
  business: BusinessHandlers;
  connections: ConnectionService;
  tenants: TenantService;
  admin?: Composer<Context>;
}): void {
  const { bot } = p;
  bot.use(idempotency(p.db, 'main'));
  // Everything below runs in the update's workspace (tenant) scope.
  bot.use(tenantScope({ db: p.db, tenants: p.tenants, api: bot.api }));

  // Business updates of accounts without an active workspace are dropped here (nothing is stored).
  const inWorkspace = (what: string): boolean => {
    if (currentTenantOrNull()) return true;
    log.warn({ update: what }, 'business update of an account without an active workspace ignored');
    return false;
  };
  bot.on('business_connection', async (ctx) => {
    if (inWorkspace('business_connection')) await p.connections.upsertFromUpdate(ctx.businessConnection);
  });
  bot.on('business_message', async (ctx) => {
    if (inWorkspace('business_message')) await p.business.onMessage(ctx.businessMessage);
  });
  bot.on('edited_business_message', async (ctx) => {
    if (inWorkspace('edited_business_message')) await p.business.onEdited(ctx.editedBusinessMessage);
  });
  bot.on('deleted_business_messages', async (ctx) => {
    if (inWorkspace('deleted_business_messages')) await p.business.onDeleted(ctx.deletedBusinessMessages);
  });

  if (p.admin) bot.use(p.admin);

  // Anyone else talking to the bot directly gets a neutral answer to /start only.
  bot.chatType('private').command('start', async (ctx) => {
    await ctx.reply('Bu shaxsiy bot.');
  });

  bot.catch((err) => {
    log.error({ error: describeError(err.error), updateId: err.ctx.update.update_id }, 'unhandled bot error');
  });
}

export function configureAdminBot(bot: Bot, db: Db, admin: Composer<Context>, tenants: TenantService): void {
  bot.use(idempotency(db, 'admin'));
  bot.use(tenantScope({ db, tenants }));
  bot.use(admin);
  bot.chatType('private').command('start', async (ctx) => {
    await ctx.reply('Bu shaxsiy bot.');
  });
  bot.catch((err) => {
    log.error({ error: describeError(err.error), updateId: err.ctx.update.update_id }, 'unhandled admin bot error');
  });
}
