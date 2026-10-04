import { buildContainer } from './app/container.js';
import { buildWorker, startScheduler } from './app/jobs.js';
import { ConfigError, loadEnv } from './config/env.js';
import { waitForDb } from './database/client.js';
import { logger } from './logging/logger.js';
import { describeError } from './logging/sanitize.js';

/** Standalone worker process (WORKER_MODE=separate): processes queued jobs, no Telegram polling. */
async function main(): Promise<void> {
  const env = loadEnv();
  const c = buildContainer(env);
  if (!(await waitForDb(c.db))) throw new Error('Database is not reachable');
  await c.mainBot.init();

  const worker = buildWorker(c);
  const stopScheduler = startScheduler(c);
  worker.start();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    stopScheduler();
    await worker.stop();
    await c.db.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => logger.error({ error: describeError(reason) }, 'unhandled promise rejection'));

main().catch((error) => {
  if (error instanceof ConfigError) console.error(error.message);
  else logger.fatal({ error: describeError(error) }, 'worker startup failed');
  process.exit(1);
});
