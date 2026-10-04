import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { childLogger } from '../logging/logger.js';
import { describeError } from '../logging/sanitize.js';

const log = childLogger('database');

export type Db = PrismaClient;

/**
 * Prisma stores DateTime values as UTC in `timestamp without time zone` columns. Raw SQL that uses
 * `now()` (job queue, leases) must see the same clock, so every connection runs in UTC — otherwise a
 * server configured for a local zone (e.g. Asia/Tashkent, +5 h) shifts delayed jobs and chat leases.
 */
export function createDb(databaseUrl: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  pool.on('connect', (client) => {
    client.query("SET TIME ZONE 'UTC'").catch(() => undefined);
  });
  // Idle connections can be closed by the server at any time (restarts, Neon/Supabase auto-suspend,
  // network blips). Without this listener such an error would be unhandled and crash the process;
  // the pool simply drops the client and opens a new one on the next query.
  pool.on('error', (error) => {
    log.warn({ error: describeError(error) }, 'idle database connection closed; it will be re-established');
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

/** Lightweight readiness probe. */
export async function pingDb(db: Db): Promise<boolean> {
  try {
    await db.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
