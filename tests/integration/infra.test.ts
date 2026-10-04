import { Bot } from 'grammy';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service.js';
import { PromptService, PromptValidationError } from '../../src/conversations/prompt.service.js';
import { EventLog } from '../../src/logging/events.js';
import { PgQueue } from '../../src/queues/pg-queue.js';
import { CleanupService } from '../../src/retention/cleanup.service.js';
import { buildDefaultSettings } from '../../src/settings/schema.js';
import { SettingsService, SettingValidationError } from '../../src/settings/settings.service.js';
import { idempotency } from '../../src/telegram/common/update-guard.js';
import { testEnv, TEST_ADMIN_ID } from '../support/env.js';
import { createTestDb, hasDb, type TestDb } from './helpers.js';

const d = hasDb ? describe : describe.skip;
const DAY = 86_400_000;

d('infrastructure (real PostgreSQL)', () => {
  let tdb: TestDb;
  beforeEach(async () => {
    if (tdb) await tdb.drop();
    tdb = await createTestDb();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('queue: dedupe keys, SKIP LOCKED claims, retry with backoff, dead letter, stale recovery', async () => {
    const q = new PgQueue(tdb.db);
    expect(await q.enqueue('text', 't', { a: 1 }, { dedupeKey: 'k1' })).toBeTypeOf('number');
    expect(await q.enqueue('text', 't', { a: 1 }, { dedupeKey: 'k1' })).toBeNull();
    for (let i = 0; i < 4; i++) await q.enqueue('text', 't', { i });

    const [a, b] = await Promise.all([q.claim('text', 'w1', 3), q.claim('text', 'w2', 3)]);
    const ids = [...a, ...b].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(5);

    const job = a[0]!;
    expect(await q.fail(job, 'boom')).toBe('retry');
    const retried = await tdb.db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(retried.status).toBe('QUEUED');
    expect(retried.runAt.getTime()).toBeGreaterThan(Date.now());
    expect(await q.fail({ ...job, attempts: 3, maxAttempts: 3 }, 'boom')).toBe('dead');

    await tdb.db.job.updateMany({ where: { status: 'RUNNING' }, data: { lockedAt: new Date(Date.now() - 3_600_000) } });
    expect(await q.recoverStale()).toBeGreaterThan(0);
  });

  it('database sessions run in UTC so raw now() matches Prisma timestamps', async () => {
    const rows = await tdb.db.$queryRaw<Array<{ tz: string }>>`SELECT current_setting('TimeZone') AS tz`;
    expect(rows[0]?.tz).toBe('UTC');
    const q = new PgQueue(tdb.db);
    // A job delayed by 1 h must not be claimable now (it was, 5 h early, with a UTC+5 session).
    await q.enqueue('text', 't', {}, { runAt: new Date(Date.now() + 3_600_000) });
    expect(await q.claim('text', 'w', 5)).toHaveLength(0);
  });

  it('update idempotency: same update_id handled once; failures release the claim', async () => {
    const bot = new Bot('123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', {
      botInfo: { id: 1, is_bot: true, first_name: 'b', username: 'b_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: true, has_main_web_app: false } as never,
    });
    let handled = 0;
    let failNext = false;
    bot.use(idempotency(tdb.db, 'main'));
    bot.use(async () => {
      if (failNext) {
        failNext = false;
        throw new Error('transient');
      }
      handled++;
    });
    const update = { update_id: 42, message: { message_id: 1, date: 1, chat: { id: 1, type: 'private', first_name: 'a' }, text: 'x' } } as never;
    await bot.handleUpdate(update);
    await bot.handleUpdate(update);
    expect(handled).toBe(1);

    failNext = true;
    const u2 = { update_id: 43, message: { message_id: 2, date: 1, chat: { id: 1, type: 'private', first_name: 'a' }, text: 'y' } } as never;
    await expect(bot.handleUpdate(u2)).rejects.toThrow();
    await bot.handleUpdate(u2);
    expect(handled).toBe(2);
  });

  it('settings: validated, cached, audited; invalid values rejected', async () => {
    const audit = new AuditService(tdb.db);
    const s = new SettingsService(tdb.db, buildDefaultSettings(testEnv()), audit);
    await s.set('aiModel', 'gemini-3.5-flash', TEST_ADMIN_ID);
    expect((await s.get()).aiModel).toBe('gemini-3.5-flash');
    await expect(s.set('personalThreshold', 1.5 as never, TEST_ADMIN_ID)).rejects.toBeInstanceOf(SettingValidationError);
    await expect(s.set('aiModel', 'bad model id!' as never, TEST_ADMIN_ID)).rejects.toBeInstanceOf(SettingValidationError);
    const logs = await tdb.db.auditLog.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe('MODEL_CHANGED');
    // A corrupted row falls back to the default instead of crashing.
    await tdb.db.setting.update({ where: { key: 'aiModel' }, data: { value: 12345 } });
    s.invalidate();
    expect((await s.get()).aiModel).toBe(testEnv().DEFAULT_AI_MODEL);
  });

  it('prompts: versioned edit, restore and reset', async () => {
    const audit = new AuditService(tdb.db);
    const p = new PromptService(tdb.db, audit, async () => 'Komron');
    expect((await p.getActive()).version).toBe(1);
    expect(await p.update('Komron React va Next.js bilan sayt yasaydi.', TEST_ADMIN_ID)).toBe(2);
    expect((await p.getActive()).content).toContain('React');
    expect(await p.restore(1, TEST_ADMIN_ID)).toBe(3);
    expect((await p.getActive()).content).toContain('Komronning Telegram yordamchisisiz');
    await expect(p.update('short', TEST_ADMIN_ID)).rejects.toBeInstanceOf(PromptValidationError);
    expect(await tdb.db.prompt.count({ where: { isActive: true } })).toBe(1);
    const actions = (await tdb.db.auditLog.findMany()).map((a) => a.action);
    expect(actions).toContain('PROMPT_CHANGED');
    expect(actions).toContain('PROMPT_RESTORED');
  });

  it('retention cleanup removes expired data and keeps recent data', async () => {
    const db = tdb.db;
    const conn = await db.telegramConnection.create({
      data: { id: 'bc', ownerUserId: 1n, userChatId: 1n, connectedAt: new Date(), authorized: true, canReply: true },
    });
    const user = await db.telegramUser.create({ data: { telegramUserId: 50n } });
    const chat = await db.chat.create({ data: { connectionId: conn.id, telegramChatId: 50n, userId: user.id } });
    const mk = (id: number, ageDays: number) =>
      db.message.create({
        data: { chatId: chat.id, senderId: user.id, telegramMessageId: id, type: 'TEXT', telegramDate: new Date(), createdAt: new Date(Date.now() - ageDays * DAY) },
      });
    await mk(1, 40);
    await mk(2, 1);
    await db.usageStat.create({ data: { provider: 'gemini', model: 'm', operation: 'TEXT', createdAt: new Date(Date.now() - 40 * DAY) } });
    await db.usageStat.create({ data: { provider: 'gemini', model: 'm', operation: 'TEXT' } });
    await db.processedUpdate.create({ data: { botKind: 'main', updateId: 1n, receivedAt: new Date(Date.now() - 5 * DAY) } });

    const storage = { put: async () => undefined, get: async () => Buffer.alloc(0), delete: async () => undefined };
    const cleanup = new CleanupService(db, new PgQueue(db), storage as never, 'data/test-tmp-nonexistent', new EventLog(db));
    const report = await cleanup.run({ ...buildDefaultSettings(testEnv()), messageRetentionDays: 30, aiLogRetentionDays: 30 });
    expect(report.messages).toBe(1);
    expect(report.usageRows).toBe(1);
    expect(report.processedUpdates).toBe(1);
    expect(await db.message.count()).toBe(1);
    expect(await db.usageStat.count()).toBe(1);
  });

  it('retention keeps set-up contacts, pending-attention messages and undeletable media; trims summaries, audit logs and dead connections', async () => {
    const db = tdb.db;
    const ago = (days: number) => new Date(Date.now() - days * DAY);
    const conn = await db.telegramConnection.create({
      data: { id: 'bc-live', ownerUserId: 1n, userChatId: 1n, connectedAt: ago(100), authorized: true, canReply: true },
    });

    // ── people (all silent for 40 days, no messages unless noted) ──
    const silent = { lastMessageAt: ago(40), createdAt: ago(40) };
    const plain = await db.telegramUser.create({ data: { telegramUserId: 60n, ...silent } });
    const tagged = await db.telegramUser.create({ data: { telegramUserId: 61n, tags: ['family'], ...silent } });
    const contact = await db.telegramUser.create({ data: { telegramUserId: 62n, isContact: true, ...silent } });
    const noted = await db.telegramUser.create({ data: { telegramUserId: 63n, notes: 'call before replying', ...silent } });
    const byName = await db.telegramUser.create({ data: { telegramUserId: 64n, username: 'Alice_X', ...silent } });
    const byId = await db.telegramUser.create({ data: { telegramUserId: 65n, ...silent } });
    const fresh = await db.telegramUser.create({ data: { telegramUserId: 66n } }); // just created, never wrote
    await db.userRule.create({ data: { matchType: 'USERNAME', matchValue: 'alice_x', mode: 'MANUAL' } });
    await db.userRule.create({ data: { matchType: 'USER_ID', matchValue: '65', mode: 'IGNORE' } });
    await db.userRule.create({ data: { matchType: 'TAG', matchValue: 'family', mode: 'MANUAL' } });

    // ── chat A: old messages in every situation ──
    const talker = await db.telegramUser.create({ data: { telegramUserId: 50n } });
    const chatA = await db.chat.create({ data: { connectionId: conn.id, telegramChatId: 50n, userId: talker.id } });
    const msg = (chatId: number, id: number, ageDays: number) =>
      db.message.create({
        data: { chatId, senderId: talker.id, telegramMessageId: id, type: 'TEXT', telegramDate: ago(ageDays), createdAt: ago(ageDays) },
      });
    const withMedia = await msg(chatA.id, 1, 40);
    const pendingAnchor = await msg(chatA.id, 2, 40);
    const pendingBurst = await msg(chatA.id, 3, 40);
    const recent = await msg(chatA.id, 4, 1);
    const mediaFails = await msg(chatA.id, 5, 40);
    const resolved = await msg(chatA.id, 6, 40);
    const media = (messageId: number, storageKey: string) =>
      db.media.create({ data: { messageId, kind: 'PHOTO', telegramFileId: 'f', telegramFileUniqueId: 'u', storageKey, status: 'DONE' } });
    await media(withMedia.id, 'media/1/1.jpg');
    await media(mediaFails.id, 'media/5/5.jpg');
    await db.ownerAttention.create({
      data: { messageId: pendingAnchor.id, chatId: chatA.id, reason: 'PERSONAL', burstMessageIds: [pendingBurst.id, pendingAnchor.id] },
    });
    await db.ownerAttention.create({ data: { messageId: resolved.id, chatId: chatA.id, reason: 'PERSONAL', status: 'IGNORED' } });
    await db.conversationSummary.create({ data: { chatId: chatA.id, summary: 'covers deleted messages', coveredUntilMessageId: resolved.id } });

    // ── chat B: nothing expired, its summary stays ──
    const chatB = await db.chat.create({ data: { connectionId: conn.id, telegramChatId: 51n } });
    await msg(chatB.id, 1, 2);
    await db.conversationSummary.create({ data: { chatId: chatB.id, summary: 'recent only', coveredUntilMessageId: 0 } });

    // ── audit logs and connections ──
    await db.auditLog.create({ data: { adminTelegramUserId: 1n, action: 'SETTING_CHANGED', createdAt: ago(400) } });
    await db.auditLog.create({ data: { adminTelegramUserId: 1n, action: 'SETTING_CHANGED', createdAt: ago(10) } });
    const deadConn = await db.telegramConnection.create({
      data: { id: 'bc-dead', ownerUserId: 1n, userChatId: 1n, connectedAt: ago(200), isEnabled: false, updatedAt: ago(40) },
    });
    await db.chat.create({ data: { connectionId: deadConn.id, telegramChatId: 70n } });
    await db.telegramConnection.create({
      data: { id: 'bc-recently-disabled', ownerUserId: 1n, userChatId: 1n, connectedAt: ago(200), isEnabled: false },
    });
    const unauthWithData = await db.telegramConnection.create({
      data: { id: 'bc-unauth-data', ownerUserId: 2n, userChatId: 2n, connectedAt: ago(200), authorized: false, updatedAt: ago(40) },
    });
    const chatC = await db.chat.create({ data: { connectionId: unauthWithData.id, telegramChatId: 71n } });
    await msg(chatC.id, 1, 3);
    expect((await db.telegramConnection.findUniqueOrThrow({ where: { id: 'bc-dead' } })).updatedAt.getTime()).toBeLessThan(ago(39).getTime());

    // Storage: records whether the message still existed when its object was deleted; one object fails.
    const deletions: Array<{ key: string; messageExisted: boolean }> = [];
    const storage = {
      put: async () => undefined,
      get: async () => null,
      delete: async (key: string) => {
        const owner = await db.message.findFirst({ where: { media: { some: { storageKey: key } } }, select: { id: true } });
        deletions.push({ key, messageExisted: owner !== null });
        if (key === 'media/5/5.jpg') throw new Error('storage unavailable');
      },
    };
    const cleanup = new CleanupService(db, new PgQueue(db), storage as never, 'data/test-tmp-nonexistent', new EventLog(db));
    const report = await cleanup.run({ ...buildDefaultSettings(testEnv()), messageRetentionDays: 30, aiLogRetentionDays: 30 });

    // CRT-15: storage objects deleted while their message still existed; a failed delete keeps the message.
    expect(deletions.map((d) => d.key).sort()).toEqual(['media/1/1.jpg', 'media/5/5.jpg']);
    expect(deletions.every((d) => d.messageExisted)).toBe(true);
    const left = (await db.message.findMany({ where: { chatId: chatA.id }, select: { id: true } })).map((m) => m.id).sort((a, b) => a - b);
    expect(left).toEqual([pendingAnchor.id, pendingBurst.id, recent.id, mediaFails.id].sort((a, b) => a - b));
    expect(report.messages).toBe(2); // withMedia + resolved
    expect(report.keptMessages).toBe(3); // pending anchor + burst + media that could not be deleted
    expect(report.mediaFiles).toBe(1);
    expect(await db.ownerAttention.count({ where: { status: 'PENDING' } })).toBe(1);

    // SEC-14: the trimmed chat's summary is gone; the untouched chat keeps its own.
    expect(await db.conversationSummary.findUnique({ where: { chatId: chatA.id } })).toBeNull();
    expect(await db.conversationSummary.findUnique({ where: { chatId: chatB.id } })).not.toBeNull();
    expect(await db.auditLog.count()).toBe(1);
    expect(report.auditLogs).toBe(1);
    expect(await db.telegramConnection.findUnique({ where: { id: 'bc-dead' } })).toBeNull();
    expect(await db.telegramConnection.findUnique({ where: { id: 'bc-recently-disabled' } })).not.toBeNull();
    expect(await db.telegramConnection.findUnique({ where: { id: 'bc-unauth-data' } })).not.toBeNull();
    expect(await db.telegramConnection.findUnique({ where: { id: conn.id } })).not.toBeNull();
    expect(report.connections).toBe(1);

    // CRT-04: only the profile with nothing set up is removed.
    const remaining = new Set((await db.telegramUser.findMany({ select: { id: true } })).map((u) => u.id));
    expect(remaining.has(plain.id)).toBe(false);
    for (const kept of [tagged, contact, noted, byName, byId, fresh, talker]) expect(remaining.has(kept.id)).toBe(true);
    expect(report.orphanUsers).toBe(1);

    // A second run is a no-op for what is protected.
    const again = await cleanup.run({ ...buildDefaultSettings(testEnv()), messageRetentionDays: 30, aiLogRetentionDays: 30 });
    expect(again.messages).toBe(0);
    expect(again.orphanUsers).toBe(0);
  });
});
