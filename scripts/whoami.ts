/**
 * Helps find ADMIN_TELEGRAM_USER_ID: send any message to the bot in a private chat, then run
 *   npm run whoami
 * Prints only numeric ids, usernames and update types — never tokens. Stop the bot first
 * (getUpdates conflicts with a running poller or an active webhook).
 */
import { loadDotEnv } from '../src/config/dotenv.js';

loadDotEnv('.env');
const token = process.env.TELEGRAM_BOT_TOKEN;
const apiRoot = process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org';
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set');
  process.exit(1);
}

interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}

async function call<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${apiRoot}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(`${method} failed: ${json.description ?? res.status}`);
  return json.result;
}

async function main(): Promise<void> {
  const me = await call<{ username: string; can_connect_to_business?: boolean }>('getMe');
  console.log(`Bot: @${me.username}  Business Mode: ${me.can_connect_to_business ? 'ON' : 'OFF (enable it in @BotFather)'}`);
  const webhook = await call<{ url: string }>('getWebhookInfo');
  if (webhook.url) {
    console.log('A webhook is set; getUpdates is unavailable. Use the business connection notice in logs instead.');
    return;
  }
  const updates = await call<Array<Record<string, unknown>>>('getUpdates', { limit: 100, timeout: 0 });
  const seen = new Map<number, string>();
  for (const u of updates) {
    const msg = (u.message ?? u.business_connection) as { from?: TgUser; user?: TgUser } | undefined;
    const user = msg?.from ?? msg?.user;
    if (user) seen.set(user.id, `${user.username ? `@${user.username}` : user.first_name ?? ''} (${Object.keys(u).filter((k) => k !== 'update_id').join(',')})`);
  }
  if (seen.size === 0) {
    console.log('No recent private messages. Send /start to the bot and run this again.');
    return;
  }
  console.log('Users seen in recent updates:');
  for (const [id, label] of seen) console.log(`  ${id}  ${label}`);
  console.log('Put your own id into ADMIN_TELEGRAM_USER_ID.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message.replace(/bot\d+:[\w-]+/g, 'bot[TOKEN]') : error);
  process.exit(1);
});
