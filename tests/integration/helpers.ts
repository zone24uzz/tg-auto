import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createDb, type Db } from '../../src/database/client.js';

export const pgServerUrl = inject('pgServerUrl');
export const hasDb = pgServerUrl !== '';

export interface TestDb {
  db: Db;
  url: string;
  drop(): Promise<void>;
}

/** Fresh, fully migrated database per test file (cloned from the migrated template). */
export async function createTestDb(): Promise<TestDb> {
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: `${pgServerUrl}/postgres` });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE autoresponder_template`);
  await admin.end();
  const url = `${pgServerUrl}/${name}`;
  const db = createDb(url);
  return {
    db,
    url,
    async drop() {
      await db.$disconnect();
      const c = new pg.Client({ connectionString: `${pgServerUrl}/postgres` });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
