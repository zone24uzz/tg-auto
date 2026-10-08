import { afterEach, describe, expect, it } from 'vitest';
import { Prisma } from '../../src/generated/prisma/client.js';
import { runAsSystem, runWithTenant, setTestFallbackScope, TenantContextMissingError } from '../../src/tenancy/context.js';
import { CrossTenantWriteError, DIRECT_MODELS, GLOBAL_MODELS, PARENT_MODELS, scopeArgs } from '../../src/tenancy/scoped-db.js';
import { TEST_ADMIN_ID } from '../support/env.js';

const T1 = { tenantId: 1, ownerTelegramUserId: 10n, language: 'uz' as const };
const T2 = { tenantId: 2, ownerTelegramUserId: 20n, language: 'ru' as const };

describe('tenancy: model classification', () => {
  it('every Prisma model is classified as direct, parent-scoped or global (exactly once)', () => {
    const models = Object.values(Prisma.ModelName) as string[];
    for (const model of models) {
      const hits = [DIRECT_MODELS.has(model), model in PARENT_MODELS, GLOBAL_MODELS.has(model)].filter(Boolean).length;
      expect(hits, model).toBe(1);
    }
  });
});

describe('tenancy: scopeArgs', () => {
  afterEach(() => setTestFallbackScope({ kind: 'tenant', tenantId: 1, ownerTelegramUserId: TEST_ADMIN_ID, language: 'uz' }));

  it('fails closed outside any scope, except for global models', () => {
    setTestFallbackScope(undefined);
    expect(() => scopeArgs('Message', 'findMany', {})).toThrow(TenantContextMissingError);
    expect(() => scopeArgs('Media', 'findMany', {})).toThrow(TenantContextMissingError);
    expect(scopeArgs('Tenant', 'findMany', { where: { id: 1 } })).toEqual({ where: { id: 1 } });
    expect(scopeArgs('Job', 'create', { data: { type: 'x' } })).toEqual({ data: { type: 'x' } });
  });

  it('system scope passes queries through unchanged', () => {
    runAsSystem(() => {
      expect(scopeArgs('Message', 'findMany', { where: { id: 5 } })).toEqual({ where: { id: 5 } });
    });
  });

  it('filters reads/updates/deletes and stamps creates with the current tenant', () => {
    runWithTenant(T1, () => {
      expect(scopeArgs('Message', 'findMany', { where: { status: 'QUEUED' } })).toEqual({ where: { status: 'QUEUED', AND: [{ tenantId: 1 }] } });
      expect(scopeArgs('Message', 'findUnique', { where: { id: 7 } })).toEqual({ where: { id: 7, AND: [{ tenantId: 1 }] } });
      expect(scopeArgs('Message', 'count', undefined)).toEqual({ where: { tenantId: 1 } });
      expect(scopeArgs('UserRule', 'create', { data: { mode: 'AUTO' } })).toEqual({ data: { mode: 'AUTO', tenantId: 1 } });
      expect(scopeArgs('UsageStat', 'createMany', { data: [{ a: 1 }, { a: 2 }] })).toEqual({ data: [{ a: 1, tenantId: 1 }, { a: 2, tenantId: 1 }] });
      expect(scopeArgs('Setting', 'upsert', { where: { k: 1 }, create: { key: 'x' }, update: { value: 1 } })).toEqual({
        where: { k: 1, AND: [{ tenantId: 1 }] },
        create: { key: 'x', tenantId: 1 },
        update: { value: 1 },
      });
      // Existing AND conditions are kept.
      expect(scopeArgs('Chat', 'findFirst', { where: { AND: { id: 3 } } })).toEqual({ where: { AND: [{ id: 3 }, { tenantId: 1 }] } });
    });
  });

  it('parent-scoped models are filtered through their parent relation', () => {
    runWithTenant(T2, () => {
      expect(scopeArgs('Media', 'findMany', { where: { messageId: 4 } })).toEqual({ where: { messageId: 4, AND: [{ message: { tenantId: 2 } }] } });
      expect(scopeArgs('ConversationSummary', 'deleteMany', {})).toEqual({ where: { chat: { tenantId: 2 } } });
      // Creates are not stamped (no column); the parent id comes from a tenant-scoped query.
      expect(scopeArgs('MessageVersion', 'create', { data: { messageId: 4 } })).toEqual({ data: { messageId: 4 } });
    });
  });

  it('rejects writes that name another tenant', () => {
    runWithTenant(T1, () => {
      expect(() => scopeArgs('UserRule', 'create', { data: { tenantId: 2 } })).toThrow(CrossTenantWriteError);
      expect(() => scopeArgs('UserRule', 'updateMany', { where: {}, data: { tenantId: 2 } })).toThrow(CrossTenantWriteError);
      expect(() => scopeArgs('Setting', 'upsert', { where: {}, create: { tenantId: 2 }, update: {} })).toThrow(CrossTenantWriteError);
    });
  });

  it('rejects unclassified models', () => {
    runWithTenant(T1, () => expect(() => scopeArgs('BrandNewTable', 'findMany', {})).toThrow(/not classified/));
  });
});
