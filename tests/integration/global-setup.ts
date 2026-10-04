import { existsSync, readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import type * as PgCluster from '../../scripts/lib/pg-cluster.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Admin connection URL of the test PostgreSQL server (no database), or '' when unavailable. */
    pgServerUrl: string;
  }
}

const TEMPLATE_DB = 'autoresponder_template';

function migrationSql(): string {
  const dir = path.resolve('prisma', 'migrations');
  if (!existsSync(dir)) throw new Error('prisma/migrations not found');
  return readdirSync(dir)
    .filter((d) => existsSync(path.join(dir, d, 'migration.sql')))
    .sort()
    .map((d) => readFileSync(path.join(dir, d, 'migration.sql'), 'utf8'))
    .join('\n');
}

async function prepareTemplate(serverUrl: string): Promise<void> {
  const admin = new pg.Client({ connectionString: `${serverUrl}/postgres` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB}`);
  await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  await admin.end();
  const client = new pg.Client({ connectionString: `${serverUrl}/${TEMPLATE_DB}` });
  await client.connect();
  await client.query(migrationSql());
  await client.end();
}

/**
 * Starts one PostgreSQL for all integration tests:
 *  - TEST_PG_SERVER_URL (e.g. postgresql://postgres:postgres@localhost:5432) when provided (CI/Docker), or
 *  - an embedded PostgreSQL (dev dependency `embedded-postgres`) on a random port.
 * When neither works, integration tests are skipped (unit tests still run).
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const external = process.env.TEST_PG_SERVER_URL?.replace(/\/+$/, '');
  if (external) {
    await prepareTemplate(external);
    project.provide('pgServerUrl', external);
    return async () => undefined;
  }

  let cluster: typeof PgCluster;
  try {
    cluster = await import('../../scripts/lib/pg-cluster.js');
    await cluster.pgBinaries();
  } catch (error) {
    console.warn('[integration] embedded PostgreSQL binaries unavailable and TEST_PG_SERVER_URL unset → skipping DB tests:', error instanceof Error ? error.message : error);
    project.provide('pgServerUrl', '');
    return async () => undefined;
  }

  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'tgai-pg-')), 'data');
  const port = 55_000 + Math.floor(Math.random() * 5_000);
  try {
    await cluster.initCluster(dir);
    await cluster.startCluster(dir, port);
    const url = `postgresql://postgres:postgres@127.0.0.1:${port}`;
    await prepareTemplate(url);
    project.provide('pgServerUrl', url);
  } catch (error) {
    console.warn('[integration] could not start PostgreSQL → skipping DB tests:', error instanceof Error ? error.message : error);
    project.provide('pgServerUrl', '');
    await cluster.stopCluster(dir).catch(() => undefined);
    return async () => undefined;
  }
  return async () => {
    await cluster.stopCluster(dir).catch(() => undefined);
    rmSync(path.dirname(dir), { recursive: true, force: true });
  };
}
