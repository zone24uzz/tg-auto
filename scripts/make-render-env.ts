/**
 * Writes data/render.env with the secret variables Render needs (copied from your local .env), ready for
 * Render → Environment → "Add from .env". data/ is git-ignored; delete the file after pasting.
 *   npx tsx scripts/make-render-env.ts "<neon postgres connection string>"
 * Prints only variable NAMES, never values.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'ADMIN_TELEGRAM_USER_ID',
  'OWNER_DISPLAY_NAME',
  'TELEGRAM_API_ID',
  'TELEGRAM_API_HASH',
  'GEMINI_API_KEY',
  'DATA_ENCRYPTION_KEY',
] as const;

const databaseUrl = process.argv[2]?.trim();
if (!databaseUrl || !/^postgres(ql)?:\/\//.test(databaseUrl)) {
  console.error('Usage: npx tsx scripts/make-render-env.ts "postgresql://user:pass@host/db?sslmode=require"');
  process.exit(1);
}
if (!existsSync('.env')) {
  console.error('.env not found');
  process.exit(1);
}
const local = parseEnv(readFileSync('.env', 'utf8'));
const missing = KEYS.filter((k) => !local[k]);
if (missing.length > 0) {
  console.error(`missing in .env: ${missing.join(', ')}`);
  process.exit(1);
}
const lines = [`DATABASE_URL=${databaseUrl}`, ...KEYS.map((k) => `${k}=${local[k]}`)];
mkdirSync('data', { recursive: true });
writeFileSync('data/render.env', `${lines.join('\n')}\n`, { mode: 0o600 });
console.log(`data/render.env written with: DATABASE_URL, ${KEYS.join(', ')}`);
console.log('Paste it into Render → Environment → Add from .env, then delete the file.');
