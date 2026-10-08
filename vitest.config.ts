import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    // Integration tests share one embedded PostgreSQL instance (see tests/integration/global-setup.ts).
    globalSetup: ['tests/integration/global-setup.ts'],
    // Services are called directly in tests: run them as tenant #1 unless a test picks a tenant.
    setupFiles: ['tests/support/tenant-scope.ts'],
    fileParallelism: true,
  },
});
