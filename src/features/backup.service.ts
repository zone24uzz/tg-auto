import { gunzipSync, gzipSync } from 'node:zlib';
import type { Db } from '../database/client.js';
import type { ContentCipher } from '../security/crypto.js';
import { currentTenant } from '../tenancy/context.js';
import { localDateKey } from '../utils/time.js';

/** Bump when the backup layout changes (the restore script checks it). */
export const BACKUP_FORMAT = 1;
/** Recent messages kept in a backup (older ones are only in the database). */
const BACKUP_MESSAGE_DAYS = 30;
const BACKUP_MAX_MESSAGES = 20_000;

export interface BackupFile {
  file: Buffer;
  filename: string;
  counts: Record<string, number>;
  encrypted: boolean;
}

/** JSON with BigInt and Date support (BigInt → string). */
function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

/**
 * Daily backup of the current workspace: settings, prompts, rules, contacts (with birthdays, tags,
 * notes), chats, the last 30 days of messages, assistant tasks and channels. Message content stays as
 * stored (encrypted at rest), the whole file is gzip'ed and — when DATA_ENCRYPTION_KEY is set —
 * encrypted again, so only this server's key can open it (`npm run backup:restore`). API keys and
 * login sessions are never included.
 */
export class BackupService {
  constructor(private readonly d: { db: Db; cipher: ContentCipher; timezone: string; now?: () => Date }) {}

  async create(): Promise<BackupFile> {
    const now = this.d.now?.() ?? new Date();
    const db = this.d.db;
    const since = new Date(now.getTime() - BACKUP_MESSAGE_DAYS * 86_400_000);
    const [settings, prompts, rules, users, chats, messages, tasks, channels] = await Promise.all([
      db.setting.findMany(),
      db.prompt.findMany(),
      db.userRule.findMany(),
      db.telegramUser.findMany(),
      db.chat.findMany(),
      db.message.findMany({ where: { createdAt: { gte: since } }, orderBy: { id: 'desc' }, take: BACKUP_MAX_MESSAGES }),
      db.assistantTask.findMany({ where: { active: true } }),
      db.channel.findMany(),
    ]);
    const tenant = currentTenant('backup');
    const data = { settings, prompts, rules, users, chats, messages, tasks, channels };
    const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length]));
    const payload = toJson({ format: BACKUP_FORMAT, createdAt: now.toISOString(), tenantId: tenant.tenantId, counts, data });
    const zipped = gzipSync(Buffer.from(payload, 'utf8'));
    const encrypted = this.d.cipher.enabled;
    const file = encrypted ? this.d.cipher.encryptBuffer(zipped) : zipped;
    const day = localDateKey(now, this.d.timezone);
    return { file, filename: `backup-${day}.json.gz${encrypted ? '.enc' : ''}`, counts, encrypted };
  }
}

/** Opens a backup file (decrypts when needed) — used by the restore script and tests. */
export function readBackup(cipher: ContentCipher, file: Buffer): { format: number; createdAt: string; tenantId: number; counts: Record<string, number>; data: Record<string, Array<Record<string, unknown>>> } {
  const plain = cipher.decryptBuffer(file);
  return JSON.parse(gunzipSync(plain).toString('utf8')) as ReturnType<typeof readBackup>;
}
