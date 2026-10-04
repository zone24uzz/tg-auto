import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * Loads a project-local `.env` file and lets it OVERRIDE variables inherited from the shell.
 * A global variable on the developer's machine (e.g. another bot's TELEGRAM_BOT_TOKEN) must
 * never silently hijack this project. In Docker/production there is no `.env` file inside the
 * image, so real environment variables are used as-is.
 * Returns the names (never values) of variables whose shell value was replaced.
 */
export function loadDotEnv(file = '.env'): string[] {
  if (!existsSync(file)) return [];
  const parsed = parseEnv(readFileSync(file, 'utf8'));
  const overridden: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined) continue;
    const current = process.env[key];
    if (current !== undefined && current !== value && current !== '') overridden.push(key);
    process.env[key] = value;
  }
  return overridden;
}
