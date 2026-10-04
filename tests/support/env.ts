import { parseEnv, type Env } from '../../src/config/env.js';

export const TEST_ADMIN_ID = 777000111n;

/** A valid Env for tests; secrets are fake. */
export function testEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/test',
    TELEGRAM_BOT_TOKEN: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ADMIN_TELEGRAM_USER_ID: TEST_ADMIN_ID.toString(),
    GEMINI_API_KEY: 'test-gemini-key-000000',
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    ...overrides,
  });
}
