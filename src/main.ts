import type { Server } from 'node:http';
import { Composer, type Context } from 'grammy';
import type { UserbotRuntime } from './app/userbot-contract.js';
import { buildContainer } from './app/container.js';
import { buildWorker, startScheduler } from './app/jobs.js';
import { ConfigError, loadEnv } from './config/env.js';
import { pingDb, waitForDb } from './database/client.js';
import { logger } from './logging/logger.js';
import { describeError } from './logging/sanitize.js';
import { publishAdminCommands } from './telegram/admin/commands-menu.js';
import { createAdminComposer } from './telegram/admin/index.js';
import { WEBHOOK_PATHS, startHttpServer } from './telegram/common/webhook-server.js';
import { ADMIN_ALLOWED_UPDATES, MAIN_ALLOWED_UPDATES, configureAdminBot, configureMainBot } from './telegram/main/bot.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const c = buildContainer(env);

  if (!(await waitForDb(c.db))) throw new Error('Database is not reachable (check DATABASE_URL and run migrations)');
  await c.db.admin.upsert({
    where: { telegramUserId: env.ADMIN_TELEGRAM_USER_ID },
    create: { telegramUserId: env.ADMIN_TELEGRAM_USER_ID },
    update: {},
  });

  const admin = createAdminComposer({
    db: c.db,
    adminTelegramUserId: env.ADMIN_TELEGRAM_USER_ID,
    timezone: env.TIMEZONE,
    encryptionEnabled: c.cipher.enabled,
    settings: c.settings,
    rules: c.rules,
    users: c.users,
    prompts: c.prompts,
    attention: c.attention,
    history: c.history,
    stats: c.stats,
    usage: c.usage,
    audit: c.audit,
    events: c.events,
    privacy: c.privacy,
    registry: c.registry,
    pipeline: c.pipeline,
    queue: c.queue,
    connections: c.connections,
    cleanup: c.cleanup,
    assistant: c.assistant,
  });

  if (!c.cipher.enabled) {
    logger.warn('DATA_ENCRYPTION_KEY is not set: message content is stored UNENCRYPTED. Set it before going live.');
    await c.events.warn('app', 'encryption at rest is OFF (DATA_ENCRYPTION_KEY missing)');
  }

  // Userbot (MTProto) transport: the owner's own account receives and sends the messages.
  let userbot: UserbotRuntime | null = null;
  if (env.TELEGRAM_TRANSPORT === 'userbot') {
    const { createUserbotRuntime } = await import('./telegram/userbot/index.js');
    userbot = createUserbotRuntime({
      db: c.db,
      cipher: c.cipher,
      apiId: Number(env.TELEGRAM_API_ID),
      apiHash: env.TELEGRAM_API_HASH!,
      mtproto: { port: env.MTPROTO_PORT === '80' ? 80 : 443, obfuscated: env.MTPROTO_OBFUSCATED },
      ...(env.TELEGRAM_SESSION ? { envSession: env.TELEGRAM_SESSION } : {}),
      adminTelegramUserId: env.ADMIN_TELEGRAM_USER_ID,
      tmpDir: env.MEDIA_TMP_DIR,
      business: c.business,
      connections: c.connections,
      notifier: c.notifier,
      events: c.events,
      onReady: (transport) => c.sender.setUserbotTransport(transport),
      onLoggedOut: () => c.sender.setUserbotTransport(null),
      onPresence: (userId, state) => {
        c.assistant.onPresence(userId, state).catch((error: unknown) => logger.warn({ err: error }, 'assistant presence handler failed'));
      },
    });
    c.downloader.setUserbotDownloader(userbot.downloader);
    c.assistant.attachUserbot(userbot.assistantApi);
  }
  const adminStack = new Composer<Context>();
  if (userbot) adminStack.use(userbot.composer);
  adminStack.use(admin);

  configureMainBot({
    bot: c.mainBot,
    db: c.db,
    business: c.business,
    connections: c.connections,
    ...(c.adminBot ? {} : { admin: adminStack }),
  });
  if (c.adminBot) configureAdminBot(c.adminBot, c.db, adminStack);

  await c.mainBot.init();
  await c.adminBot?.init();
  // The owner's "/" command menu, re-published on every start so it always matches the code.
  await publishAdminCommands((c.adminBot ?? c.mainBot).api, env.ADMIN_TELEGRAM_USER_ID, { userbot: env.TELEGRAM_TRANSPORT === 'userbot' }).catch((error: unknown) =>
    logger.warn({ err: error }, 'could not publish the admin command menu'),
  );
  if (env.TELEGRAM_TRANSPORT === 'business' && !c.mainBot.botInfo.can_connect_to_business) {
    logger.warn(
      'Business Mode is OFF for this bot. Enable it in @BotFather → /mybots → Bot Settings → Business Mode, then connect the bot in Telegram → Settings → Telegram Business → Chatbots.',
    );
  }

  const worker = env.WORKER_MODE === 'embedded' ? buildWorker(c) : null;
  const stopScheduler = env.WORKER_MODE === 'embedded' ? startScheduler(c) : () => {};
  worker?.start();

  let server: Server | undefined;
  if (env.TELEGRAM_UPDATE_MODE === 'webhook') {
    server = startHttpServer({
      port: env.PORT,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
      mainBot: c.mainBot,
      ...(c.adminBot ? { adminBot: c.adminBot } : {}),
      readiness: () => pingDb(c.db),
    });
    const base = env.TELEGRAM_WEBHOOK_URL!.replace(/\/+$/, '');
    await c.mainBot.api.setWebhook(`${base}${WEBHOOK_PATHS.main}`, {
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: [...MAIN_ALLOWED_UPDATES],
      max_connections: 20,
    });
    if (c.adminBot)
      await c.adminBot.api.setWebhook(`${base}${WEBHOOK_PATHS.admin}`, {
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: [...ADMIN_ALLOWED_UPDATES],
      });
    logger.info({ mode: 'webhook' }, 'webhooks registered');
  } else {
    server = startHttpServer({ port: env.PORT, readiness: () => pingDb(c.db) });
    void c.mainBot.start({
      allowed_updates: [...MAIN_ALLOWED_UPDATES],
      onStart: (info) => logger.info({ bot: info.username, mode: 'polling' }, 'main bot polling'),
    });
    if (c.adminBot)
      void c.adminBot.start({
        allowed_updates: [...ADMIN_ALLOWED_UPDATES],
        onStart: (info) => logger.info({ bot: info.username }, 'admin bot polling'),
      });
  }
  await userbot?.start();
  await c.events.info('app', `started (${env.TELEGRAM_TRANSPORT}, ${env.TELEGRAM_UPDATE_MODE}, worker=${env.WORKER_MODE})`);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    try {
      if (env.TELEGRAM_UPDATE_MODE === 'polling') {
        await c.mainBot.stop();
        await c.adminBot?.stop();
      }
      server?.close();
      await userbot?.stop();
      stopScheduler();
      await worker?.stop();
      await c.db.$disconnect();
    } catch (error) {
      logger.error({ error: describeError(error) }, 'error during shutdown');
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
  logger.error({ error: describeError(reason) }, 'unhandled promise rejection');
});
process.on('uncaughtException', (error) => {
  logger.fatal({ error: describeError(error) }, 'uncaught exception');
  process.exit(1);
});

main().catch((error) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    logger.fatal({ error: describeError(error) }, 'startup failed');
  }
  process.exit(1);
});
