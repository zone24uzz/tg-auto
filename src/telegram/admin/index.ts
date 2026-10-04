import { Composer, type Context } from 'grammy';
import { registerSettingControls } from './controls.js';
import type { AdminDeps } from './deps.js';
import { handleCallback, handleMessage } from './dispatch.js';
import { adminGuard } from './guard.js';
import type { AdminKit } from './kit.js';
import { AdminRouter } from './router.js';
import { AdminStateStore } from './state.js';
import { registerAdvanced } from './views/advanced.js';
import { registerAttention } from './views/attention.js';
import { registerAutoReply } from './views/auto-reply.js';
import { registerHistory } from './views/history.js';
import { registerLists } from './views/lists.js';
import { registerLogs } from './views/logs.js';
import { registerMain } from './views/main.js';
import { registerMaintenance } from './views/maintenance.js';
import { registerMedia } from './views/media.js';
import { registerModels } from './views/models.js';
import { registerPersonal } from './views/personal.js';
import { registerPrivacy } from './views/privacy.js';
import { registerPrompt } from './views/prompt.js';
import { registerRules } from './views/rules.js';
import { registerStats } from './views/stats.js';
import { registerStyle } from './views/style.js';
import { registerUsers } from './views/users.js';

/** Builds the route table with every admin screen registered. Exposed for tests. */
export function createAdminKit(deps: AdminDeps): AdminKit {
  const kit: AdminKit = { deps, router: new AdminRouter(), states: new AdminStateStore(deps.db) };
  registerMain(kit);
  registerSettingControls(kit);
  registerAutoReply(kit);
  registerRules(kit);
  registerUsers(kit);
  registerLists(kit);
  registerModels(kit);
  registerStyle(kit);
  registerPrompt(kit);
  registerPersonal(kit);
  registerMedia(kit);
  registerAttention(kit);
  registerHistory(kit);
  registerStats(kit);
  registerAdvanced(kit);
  registerMaintenance(kit);
  registerLogs(kit);
  registerPrivacy(kit);
  return kit;
}

/**
 * Owner-only admin UI. Mount with `bot.use(createAdminComposer(deps))` on the admin bot,
 * or on the main bot in single-bot mode.
 *
 * Only `message` and `callback_query` updates enter; everything else (business_* updates, …)
 * passes straight through to the next middleware. Inside, the guard drops anything that is not
 * the configured admin in their private chat (callbacks answered silently, `/start` → "Bu shaxsiy bot.").
 */
export function createAdminComposer(deps: AdminDeps): Composer<Context> {
  const kit = createAdminKit(deps);
  const composer = new Composer<Context>();
  const scoped = composer.on(['message', 'callback_query']);
  scoped.use(adminGuard(deps.adminTelegramUserId));
  scoped.on('callback_query', (ctx) => handleCallback(kit, ctx));
  scoped.on('message', (ctx, next) => handleMessage(kit, ctx, next));
  return composer;
}
