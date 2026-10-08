import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { jobScope, tenantIdOfJob } from '../../src/app/jobs.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { PgQueue } from '../../src/queues/pg-queue.js';
import { RulesService } from '../../src/rules/rules.service.js';
import { buildDefaultSettings } from '../../src/settings/schema.js';
import { SettingsService } from '../../src/settings/settings.service.js';
import { runAsSystem, runWithTenant } from '../../src/tenancy/context.js';
import { TenantService } from '../../src/tenancy/tenant.service.js';
import { testEnv } from '../support/env.js';
import { createTestDb, hasDb, type TestDb } from './helpers.js';

const d = hasDb ? describe : describe.skip;

d('tenant isolation (real PostgreSQL)', () => {
  let tdb: TestDb;
  let t1: Parameters<typeof runWithTenant>[0];
  let t2: Parameters<typeof runWithTenant>[0];

  beforeAll(async () => {
    tdb = await createTestDb();
    const a = await tdb.db.tenant.create({ data: { telegramUserId: 1001n, status: 'ACTIVE' } });
    const b = await tdb.db.tenant.create({ data: { telegramUserId: 2002n, status: 'ACTIVE', language: 'ru' } });
    t1 = { tenantId: a.id, ownerTelegramUserId: a.telegramUserId, language: 'uz' };
    t2 = { tenantId: b.id, ownerTelegramUserId: b.telegramUserId, language: 'ru' };
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('settings, rules and contacts of one tenant are invisible to another', async () => {
    const audit = new AuditService(tdb.db);
    const settings = new SettingsService(tdb.db, buildDefaultSettings(testEnv()), audit);
    const rules = new RulesService(tdb.db, audit);

    await runWithTenant(t1, async () => {
      await settings.set('aiModel', 'gemini-3.5-flash', 1001n);
      await rules.setRule('USERNAME', '@ali', 'BLOCK', 1001n);
      await tdb.db.telegramUser.create({ data: { telegramUserId: 555n, firstName: 'Ali' } });
    });
    await runWithTenant(t2, async () => {
      expect((await settings.get()).aiModel).toBe(testEnv().DEFAULT_AI_MODEL);
      expect(await rules.all()).toEqual([]);
      expect(await tdb.db.telegramUser.findFirst({ where: { telegramUserId: 555n } })).toBeNull();
      expect(await tdb.db.auditLog.count()).toBe(0);
      // The same contact may exist in both workspaces.
      await tdb.db.telegramUser.create({ data: { telegramUserId: 555n, firstName: 'Ali (2)' } });
    });
    await runWithTenant(t1, async () => {
      expect((await settings.get()).aiModel).toBe('gemini-3.5-flash');
      expect((await rules.all()).map((r) => r.mode)).toEqual(['BLOCK']);
      expect((await tdb.db.telegramUser.findFirstOrThrow({ where: { telegramUserId: 555n } })).firstName).toBe('Ali');
      expect(await tdb.db.auditLog.count()).toBe(2);
    });
    await runAsSystem(async () => {
      expect(await tdb.db.telegramUser.count({ where: { telegramUserId: 555n } })).toBe(2);
    });
  });

  it('a tenant cannot update or delete another tenant’s rows by id', async () => {
    const rule = await runWithTenant(t1, () => tdb.db.userRule.create({ data: { matchType: 'TAG', matchValue: 'vip', mode: 'VIP' } }));
    await runWithTenant(t2, async () => {
      expect((await tdb.db.userRule.updateMany({ where: { id: rule.id }, data: { mode: 'BLOCK' } })).count).toBe(0);
      expect((await tdb.db.userRule.deleteMany({ where: { id: rule.id } })).count).toBe(0);
      expect(await tdb.db.userRule.findUnique({ where: { id: rule.id } })).toBeNull();
    });
    expect((await runWithTenant(t1, () => tdb.db.userRule.findUniqueOrThrow({ where: { id: rule.id } }))).mode).toBe('VIP');
  });

  it('the database rejects tenant-owned rows written without a tenant (fail closed)', async () => {
    await expect(
      tdb.db.$executeRaw`INSERT INTO user_rules ("matchType", "matchValue", mode, "updatedAt") VALUES ('TAG', 'x', 'AUTO', now())`,
    ).rejects.toThrow(/check constraint/);
  });

  it('jobs remember the tenant that enqueued them', async () => {
    const queue = new PgQueue(tdb.db);
    const id = await runWithTenant(t2, () => queue.enqueue('text', 'summary.update', { chatId: 1 }));
    const job = await tdb.db.job.findUniqueOrThrow({ where: { id: id! } });
    expect((job.payload as Record<string, unknown>).__tenantId).toBe(t2.tenantId);
    expect(await tenantIdOfJob(tdb.db, job)).toBe(t2.tenantId);
    // System jobs (no tenant) and jobs from before multi-tenancy fall back to the referenced row.
    const sys = await runAsSystem(() => queue.enqueue('maintenance', 'maintenance.cleanup', {}));
    expect(await tenantIdOfJob(tdb.db, await tdb.db.job.findUniqueOrThrow({ where: { id: sys! } }))).toBeNull();
  });

  it('jobs of a revoked workspace are completed without running', async () => {
    const queue = new PgQueue(tdb.db);
    const tenants = new TenantService(tdb.db);
    const revoked = await tdb.db.tenant.create({ data: { telegramUserId: 3003n, status: 'REJECTED' } });
    const id = await runWithTenant({ tenantId: revoked.id, ownerTelegramUserId: 3003n, language: 'uz' }, () =>
      queue.enqueue('text', 'summary.update', { chatId: 1 }),
    );
    const job = await tdb.db.job.findUniqueOrThrow({ where: { id: id! } });
    const fn = vi.fn(async () => undefined);
    await jobScope({ db: tdb.db, tenants, queue })(job, fn);
    expect(fn).not.toHaveBeenCalled();
    expect((await tdb.db.job.findUniqueOrThrow({ where: { id: id! } })).status).toBe('DONE');
    // A workspace job whose tenant cannot be determined never runs in system scope either.
    const orphan = await runAsSystem(() => queue.enqueue('text', 'message.process', { messageId: 999999 }));
    const orphanJob = await tdb.db.job.findUniqueOrThrow({ where: { id: orphan! } });
    await jobScope({ db: tdb.db, tenants, queue })(orphanJob, fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('tenant service: active lookup by owner, super-admin bootstrap', async () => {
    const tenants = new TenantService(tdb.db);
    expect((await tenants.activeByTelegramUserId(1001n))?.id).toBe(t1.tenantId);
    expect(await tenants.activeByTelegramUserId(9999n)).toBeNull();
    const sa = await tenants.ensureSuperAdmin(7777n);
    expect(sa.status).toBe('ACTIVE');
    expect((await tenants.ensureSuperAdmin(7777n)).id).toBe(sa.id);
  });
});
