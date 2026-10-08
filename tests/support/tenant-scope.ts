import { setTestFallbackScope } from '../../src/tenancy/context.js';
import { TEST_ADMIN_ID } from './env.js';

/**
 * Tests call services directly (no Telegram update / worker entry point), so they run as tenant #1
 * owned by the test admin. Isolation tests switch tenants explicitly with runWithTenant/runAsSystem.
 */
export const TEST_TENANT_ID = 1;
setTestFallbackScope({ kind: 'tenant', tenantId: TEST_TENANT_ID, ownerTelegramUserId: TEST_ADMIN_ID, language: 'uz' });
