/**
 * Opens a daily backup (backup-YYYY-MM-DD.json.gz.enc from the admin chat) with this server's
 * DATA_ENCRYPTION_KEY.
 *
 *   npm run backup:restore -- backup-2026-10-27.json.gz.enc            → writes a readable JSON next to it
 *   npm run backup:restore -- backup-2026-10-27.json.gz.enc --apply    → restores settings, prompts, rules and
 *                                                                        contacts (birthdays, tags, notes) into DATABASE_URL
 *
 * The readable JSON contains private conversations: keep it local and delete it when done.
 * Messages are not re-imported (they stay in the file for reference).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadDotEnv } from '../src/config/dotenv.js';
import { createDb } from '../src/database/client.js';
import { readBackup } from '../src/features/backup.service.js';
import { ContentCipher } from '../src/security/crypto.js';
import { runAsSystem, runWithTenant } from '../src/tenancy/context.js';

loadDotEnv();
const [file, ...flags] = process.argv.slice(2);
if (!file) throw new Error('usage: npm run backup:restore -- <backup file> [--apply]');
const cipher = new ContentCipher(process.env.DATA_ENCRYPTION_KEY);
const backup = readBackup(cipher, readFileSync(file));
console.log(`backup format ${backup.format}, created ${backup.createdAt}, workspace #${backup.tenantId}`);
console.log('rows:', backup.counts);

/** Content columns are encrypted at rest: decrypt them for the readable copy. */
const CONTENT_FIELDS = ['currentText', 'currentCaption', 'classificationReason', 'text', 'notes', 'instructions'];
const readable = Object.fromEntries(
  Object.entries(backup.data).map(([table, rows]) => [
    table,
    rows.map((row) => {
      const out: Record<string, unknown> = { ...row };
      for (const f of CONTENT_FIELDS) if (typeof out[f] === 'string') out[f] = cipher.decrypt(out[f] as string);
      return out;
    }),
  ]),
);

if (!flags.includes('--apply')) {
  const out = file.replace(/\.json\.gz(\.enc)?$/, '') + '.json';
  writeFileSync(out, JSON.stringify({ ...backup, data: readable }, null, 2), { mode: 0o600 });
  console.log(`written: ${out} (private data — delete it when done)`);
  process.exit(0);
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const db = createDb(url);
const INTERNAL = new Set(['lastCleanupAt', 'costLimitNotifiedOn', 'morningSummarySentOn', 'backupDoneOn']);
try {
  const tenant = await runAsSystem(() => db.tenant.findUnique({ where: { id: backup.tenantId } }));
  if (!tenant) throw new Error(`workspace #${backup.tenantId} does not exist in this database`);
  await runWithTenant({ tenantId: tenant.id, ownerTelegramUserId: tenant.telegramUserId, language: 'uz' }, async () => {
    let settings = 0;
    for (const row of backup.data.settings ?? []) {
      const key = String(row.key);
      if (INTERNAL.has(key)) continue;
      await db.setting.upsert({
        where: { tenantId_key: { tenantId: tenant.id, key } },
        create: { key, value: row.value as never },
        update: { value: row.value as never },
      });
      settings++;
    }
    let prompts = 0;
    if ((await db.prompt.count()) === 0) {
      for (const row of backup.data.prompts ?? []) {
        await db.prompt.create({ data: { kind: String(row.kind), version: Number(row.version), content: String(row.content), isActive: row.isActive === true } });
        prompts++;
      }
    }
    const rules = await db.userRule.createMany({
      data: (backup.data.rules ?? []).map((r) => ({ matchType: r.matchType as never, matchValue: String(r.matchValue), mode: r.mode as never, note: (r.note as string | null) ?? null })),
      skipDuplicates: true,
    });
    let users = 0;
    for (const u of backup.data.users ?? []) {
      const telegramUserId = BigInt(String(u.telegramUserId));
      const keep = {
        birthday: (u.birthday as string | null) ?? null,
        birthdaySource: (u.birthdaySource as string | null) ?? null,
        tags: (u.tags as string[] | undefined) ?? [],
        notes: (u.notes as string | null) ?? null,
      };
      const existing = await db.telegramUser.findFirst({ where: { telegramUserId } });
      if (existing) await db.telegramUser.update({ where: { id: existing.id }, data: keep });
      else
        await db.telegramUser.create({
          data: { telegramUserId, username: (u.username as string | null) ?? null, firstName: (u.firstName as string | null) ?? null, lastName: (u.lastName as string | null) ?? null, isContact: u.isContact === true, ...keep },
        });
      users++;
    }
    console.log(`restored: ${settings} settings, ${prompts} prompts, ${rules.count} rules, ${users} contacts`);
  });
} finally {
  await db.$disconnect();
}
