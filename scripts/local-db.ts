/**
 * Local PostgreSQL without Docker (development only).
 *   npm run db:local   → starts PostgreSQL on 127.0.0.1:54329 (data in ./.pg-local), Ctrl+C stops it
 * Then in another terminal: npx prisma migrate deploy && npm run dev
 */
import path from 'node:path';
import pg from 'pg';
import { initCluster, isInitialised, startCluster, stopCluster } from './lib/pg-cluster.js';

const PORT = Number(process.env.LOCAL_PG_PORT ?? 54329);
const dataDir = path.resolve('.pg-local', 'data');

async function main(): Promise<void> {
  if (!isInitialised(dataDir)) {
    console.log('Initialising a new local PostgreSQL cluster in ./.pg-local …');
    await initCluster(dataDir);
  }
  await startCluster(dataDir, PORT);
  const client = new pg.Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
  await client.connect();
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', ['autoresponder']);
  if (exists.rowCount === 0) await client.query('CREATE DATABASE autoresponder');
  await client.end();

  console.log(`PostgreSQL is running: postgresql://postgres:postgres@localhost:${PORT}/autoresponder`);
  console.log('Press Ctrl+C to stop.');
  const stop = async () => {
    await stopCluster(dataDir).catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  setInterval(() => undefined, 1 << 30);
}

main().catch(async (error: unknown) => {
  console.error('Failed to start local PostgreSQL:', error instanceof Error ? error.message : error);
  await stopCluster(dataDir).catch(() => undefined);
  process.exit(1);
});
