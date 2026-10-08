import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UserbotRuntime } from '../../src/app/userbot-contract.js';
import { EventLog } from '../../src/logging/events.js';
import { resolveUpdateTenant } from '../../src/tenancy/bot-scope.js';
import { runAsSystem, runWithTenant, setTestFallbackScope, TenantContextMissingError } from '../../src/tenancy/context.js';
import { TenantService } from '../../src/tenancy/tenant.service.js';
import { UserbotManager } from '../../src/telegram/userbot/manager.js';
import { TEST_ADMIN_ID } from '../support/env.js';
import { createTestDb, hasDb, type TestDb } from './helpers.js';

const d = hasDb ? describe : describe.skip;

/**
 * Production entry points run WITHOUT the test fallback scope: a query that escapes its scope must fail
 * here exactly like it does in production (this caught a startup crash: lazy Prisma queries built inside
 * runAsSystem but executed outside it).
 */
d('tenancy entry points without the test fallback scope (real PostgreSQL)', () => {
  let tdb: TestDb;
  let superTenant: Awaited<ReturnType<TenantService['ensureSuperAdmin']>>;
  let other: typeof superTenant;
  let tenants: TenantService;

  beforeAll(async () => {
    tdb = await createTestDb();
    tenants = new TenantService(tdb.db);
    superTenant = await tenants.ensureSuperAdmin(5001n);
    other = await tdb.db.tenant.create({ data: { telegramUserId: 5002n, status: 'ACTIVE' } });
    await runWithTenant({ tenantId: other.id, ownerTelegramUserId: 5002n, language: 'uz' }, async () => {
      await tdb.db.userbotSession.create({ data: { session: 'enc:v1:x', ownerUserId: 5002n } });
      await tdb.db.telegramConnection.create({
        data: { id: 'bc-other', ownerUserId: 5002n, userChatId: 5002n, connectedAt: new Date(), authorized: true },
      });
    });
    setTestFallbackScope(undefined);
  });
  afterAll(async () => {
    setTestFallbackScope({ kind: 'tenant', tenantId: 1, ownerTelegramUserId: TEST_ADMIN_ID, language: 'uz' });
    await tdb?.drop();
  });

  it('lazy Prisma queries built inside runAsSystem / runWithTenant run in that scope', async () => {
    await expect(tdb.db.userbotSession.findMany()).rejects.toBeInstanceOf(TenantContextMissingError);
    expect(await runAsSystem(() => tdb.db.userbotSession.findMany())).toHaveLength(1);
    const own = await runWithTenant({ tenantId: superTenant.id, ownerTelegramUserId: 5001n, language: 'uz' }, () => tdb.db.userbotSession.findMany());
    expect(own).toHaveLength(0);
  });

  it('a business update resolves to the connection owner’s workspace', async () => {
    const tenant = await resolveUpdateTenant(
      { db: tdb.db, tenants },
      { update_id: 1, business_message: { business_connection_id: 'bc-other', message_id: 1, date: 0, chat: { id: 9, type: 'private', first_name: 'x' } } } as never,
    );
    expect(tenant?.id).toBe(other.id);
  });

  it('userbot manager starts the super-admin and every workspace with a stored session', async () => {
    const started: bigint[] = [];
    const manager = new UserbotManager({
      base: { db: tdb.db } as never,
      superAdminId: 5001n,
      tenants,
      create: (deps) => ({ start: vi.fn(async () => void started.push(deps.adminTelegramUserId)), stop: vi.fn(async () => undefined) }) as unknown as UserbotRuntime,
      setTransport: () => undefined,
    });
    await manager.startAll();
    expect(started.sort()).toEqual([5001n, 5002n]);
  });

  it('the super-admin’s logs include system-wide events, other workspaces only their own', async () => {
    const events = new EventLog(tdb.db);
    await runAsSystem(() => events.info('app', 'system started'));
    await runWithTenant({ tenantId: other.id, ownerTelegramUserId: 5002n, language: 'uz' }, () => events.info('x', 'other tenant event'));
    const superView = await runWithTenant({ tenantId: superTenant.id, ownerTelegramUserId: 5001n, language: 'uz' }, () => events.recent(20, 0, undefined, true));
    expect(superView.map((e) => e.message)).toContain('system started');
    expect(superView.map((e) => e.message)).not.toContain('other tenant event');
  });
});
