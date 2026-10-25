/**
 * Checks that the app's own DB client (Prisma + pg adapter + tenancy extension) works with DATABASE_URL:
 * readiness ping, migrations present, tenant table readable. Prints no secrets.
 *
 *   DATABASE_URL=... node --import tsx scripts/db-smoke.ts
 */
import { createDb, pingDb } from '../src/database/client.js';
import { runAsSystem } from '../src/tenancy/context.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const db = createDb(url);
try {
  const started = Date.now();
  console.log('ping:', await pingDb(db), `${Date.now() - started}ms`);
  const migrations = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
  console.log('applied migrations:', Number(migrations[0]?.n ?? 0));
  console.log('tenants:', await db.tenant.count());
  console.log('settings rows (system scope):', await runAsSystem(() => db.setting.count()));
} finally {
  await db.$disconnect();
}
