import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { businessMessage, buildHarness, CONNECTION_ID, OWNER_ID } from '../support/harness.js';
import { createTestDb, hasDb, type TestDb } from './helpers.js';

const d = hasDb ? describe : describe.skip;

d('message flow (real PostgreSQL)', () => {
  let tdb: TestDb;
  let h: Awaited<ReturnType<typeof buildHarness>>;

  beforeEach(async () => {
    if (tdb) await tdb.drop();
    tdb = await createTestDb();
    h = await buildHarness(tdb.db);
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('business question: stored encrypted, classified BUSINESS, answered once', async () => {
    const m = businessMessage({ text: 'Salom, website yasab berasizlarmi?' });
    await h.business.onMessage(m);
    const stored = await h.db.message.findFirstOrThrow({ where: { telegramMessageId: m.message_id } });
    expect(stored.currentText).toMatch(/^enc:v1:/);
    await h.drain();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.connectionId).toBe(CONNECTION_ID);
    const after = await h.db.message.findUniqueOrThrow({ where: { id: stored.id } });
    expect(after.status).toBe('ANSWERED');
    expect(after.classification).toBe('BUSINESS');
    const resp = await h.db.aiResponse.findFirstOrThrow({ where: { sourceMessageId: stored.id } });
    expect(resp).toMatchObject({ kind: 'AUTO_REPLY', status: 'SENT', model: 'gemini-3.8-flash' });
    expect(resp.text).toMatch(/^enc:v1:/);
    // outgoing reply is stored for conversation history
    expect(await h.db.message.count({ where: { direction: 'OUTGOING_BOT' } })).toBe(1);
  });

  it('duplicate Telegram delivery and job re-runs never send twice', async () => {
    const m = businessMessage({ text: 'Saytingiz qancha turadi?' });
    await h.business.onMessage(m);
    await h.business.onMessage(m); // same update delivered again
    expect(await h.db.message.count({ where: { direction: 'INCOMING' } })).toBe(1);
    expect(await h.db.job.count()).toBe(1);
    await h.drain();
    const msg = await h.db.message.findFirstOrThrow({ where: { telegramMessageId: m.message_id } });
    // Simulate a crashed worker re-running the job after the reply was claimed.
    await h.db.message.update({ where: { id: msg.id }, data: { status: 'QUEUED' } });
    await h.pipeline.processMessage(msg.id, 'text');
    expect(h.sent).toHaveLength(1);
  });

  it('personal question: no AI answer, waiting message, owner attention + admin notification', async () => {
    const m = businessMessage({ text: 'Bugun soat nechida bo‘shsan?' });
    await h.business.onMessage(m);
    await h.drain();
    expect(h.ai.generateReply).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toBe('Bu shaxsiy savol ekan. Komron keyinroq o‘zi javob beradi 🙂');
    const msg = await h.db.message.findFirstOrThrow({ where: { telegramMessageId: m.message_id } });
    expect(msg.status).toBe('OWNER_ATTENTION');
    expect(msg.classification).toBe('PERSONAL');
    const att = await h.db.ownerAttention.findFirstOrThrow({ where: { messageId: msg.id } });
    expect(att.status).toBe('PENDING');
    expect(h.notifier.ownerAttention).toHaveBeenCalledTimes(1);
  });

  it('the waiting message is not repeated within the cooldown', async () => {
    await h.business.onMessage(businessMessage({ text: 'Qayerdasan?' }));
    await h.drain();
    await h.business.onMessage(businessMessage({ text: 'Kim bilan yuribsan?' }));
    await h.drain();
    expect(h.sent).toHaveLength(1);
    expect(await h.db.ownerAttention.count()).toBe(2);
  });

  it('owner writing in the chat resolves pending attention', async () => {
    await h.business.onMessage(businessMessage({ text: 'Ertaga kelasizmi?' }));
    await h.drain();
    await h.business.onMessage(businessMessage({ from: { id: Number(OWNER_ID), is_bot: false, first_name: 'Komron' }, text: 'Ha, kelaman' }));
    const att = await h.db.ownerAttention.findFirstOrThrow();
    expect(att.status).toBe('RESOLVED_BY_OWNER');
  });

  it('LLM decides REQUIRES_OWNER from context', async () => {
    h.aiState.classification = { category: 'REQUIRES_OWNER', confidence: 0.9, requires_owner: true, reason: 'needs a commitment' };
    await h.business.onMessage(businessMessage({ text: 'Shartnomani shu hafta imzolaymizmi?' }));
    await h.drain();
    expect(h.ai.generateReply).not.toHaveBeenCalled();
    expect(await h.db.ownerAttention.count()).toBe(1);
  });

  it('blocked and ignored users are stored but never answered', async () => {
    await h.rules.setRule('USER_ID', '4242', 'BLOCK', OWNER_ID);
    await h.business.onMessage(businessMessage({ text: 'Salom' }));
    await h.rules.setRule('USERNAME', 'spammer', 'IGNORE', OWNER_ID);
    await h.business.onMessage(businessMessage({ fromId: 5555, username: 'spammer', text: 'Salom' }));
    await h.drain();
    expect(h.sent).toHaveLength(0);
    expect(await h.db.job.count()).toBe(0);
    expect(await h.db.message.count({ where: { status: 'IGNORED' } })).toBe(2);
  });

  it('MANUAL users are not answered; VIP users notify the owner', async () => {
    await h.rules.setRule('USER_ID', '4242', 'MANUAL', OWNER_ID);
    await h.rules.setRule('USER_ID', '6000', 'VIP', OWNER_ID);
    await h.business.onMessage(businessMessage({ text: 'Narxi qancha?' }));
    await h.business.onMessage(businessMessage({ fromId: 6000, username: 'boss', text: 'Narxi qancha?' }));
    await h.drain();
    expect(h.sent).toHaveLength(0);
    expect(await h.db.message.count({ where: { status: 'MANUAL' } })).toBe(2);
    expect(h.notifier.ownerAttention).toHaveBeenCalledTimes(1);
  });

  it('auto-reply OFF: messages logged, nothing sent; pause works the same', async () => {
    await h.settings.set('autoReplyEnabled', false, OWNER_ID);
    await h.business.onMessage(businessMessage({ text: 'Narxi qancha?' }));
    await h.drain();
    expect(h.sent).toHaveLength(0);
    expect(await h.db.message.count({ where: { status: 'SKIPPED' } })).toBe(1);
    expect(await h.db.auditLog.count({ where: { action: 'AUTO_REPLY_DISABLED' } })).toBe(1);

    await h.settings.set('autoReplyEnabled', true, OWNER_ID);
    await h.settings.set('pausedUntil', new Date(Date.now() + 3_600_000).toISOString(), OWNER_ID);
    await h.business.onMessage(businessMessage({ text: 'Narxi qancha?' }));
    await h.drain();
    expect(h.sent).toHaveLength(0);
  });

  it('AI failure → safe fallback text (no stack trace) + owner attention', async () => {
    h.aiState.failReply = true;
    await h.business.onMessage(businessMessage({ text: 'Saytingiz qancha turadi?' }));
    await h.drain();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toBe('Hozir javob berishda kichik muammo bor. Komron keyinroq javob beradi.');
    const att = await h.db.ownerAttention.findFirstOrThrow();
    expect(att.reason).toBe('AI_FAILED');
  });

  it('temporary AI quota limits retry the message later instead of sending the fallback', async () => {
    const { PipelineRetryLater } = await import('../../src/responder/pipeline.js');
    h.aiState.failReply = 'ratelimit';
    const m = businessMessage({ text: 'Saytingiz qancha turadi?' });
    await h.business.onMessage(m);
    const msg = await h.db.message.findFirstOrThrow({ where: { telegramMessageId: m.message_id } });
    await expect(h.pipeline.processMessage(msg.id, 'text')).rejects.toBeInstanceOf(PipelineRetryLater);
    expect(h.sent).toHaveLength(0);
    expect((await h.db.message.findUniqueOrThrow({ where: { id: msg.id } })).status).toBe('QUEUED');
    expect(await h.db.ownerAttention.count()).toBe(0);
    // quota back → the retried job answers normally
    h.aiState.failReply = false;
    await h.pipeline.processMessage(msg.id, 'text');
    expect(h.sent).toHaveLength(1);
  });

  it('a leaking AI reply is blocked by the response policy', async () => {
    h.aiState.reply = `Admin id is ${OWNER_ID}`;
    await h.business.onMessage(businessMessage({ text: 'Saytingiz qancha turadi?' }));
    await h.drain();
    expect(h.sent.map((s) => s.text)).not.toContain(`Admin id is ${OWNER_ID}`);
    expect((await h.db.ownerAttention.findFirstOrThrow()).reason).toBe('POLICY_BLOCKED');
  });

  it('per-user rate limit stops replies silently (the current burst does not count against itself)', async () => {
    await h.settings.set('maxMessagesPerMinute', 2, OWNER_ID);
    // One burst of 3 messages → one reply (CRT-14: the burst is not counted against its own limit).
    for (let i = 0; i < 3; i++) await h.business.onMessage(businessMessage({ text: `Narxi qancha? ${i}` }));
    await h.drain();
    expect(h.sent).toHaveLength(1);
    // Further messages within the minute exceed the limit: no reply, no waiting message.
    await h.business.onMessage(businessMessage({ text: 'Narxi qancha? 3' }));
    await h.drain();
    await h.business.onMessage(businessMessage({ text: 'Narxi qancha? 4' }));
    await h.drain();
    expect(h.sent).toHaveLength(1);
    expect(await h.db.message.count({ where: { status: 'RATE_LIMITED' } })).toBe(2);
    // The owner learns about it once per chat per 30 min (low priority, nothing sent to the contact).
    expect(await h.db.ownerAttention.count({ where: { reason: 'RATE_LIMITED' } })).toBe(1);
  });

  it('daily cost limit stops AI replies and notifies the owner once', async () => {
    await h.settings.set('maxDailyAiCostUsd', 0.5, OWNER_ID);
    await h.usage.record({ provider: 'gemini', model: 'x', operation: 'TEXT', costUsd: 0.6, success: true });
    await h.business.onMessage(businessMessage({ text: 'Narxi qancha?' }));
    await h.drain();
    await h.business.onMessage(businessMessage({ fromId: 4243, username: 'other', text: 'Narxi qancha?' }));
    await h.drain();
    expect(h.ai.generateReply).not.toHaveBeenCalled();
    expect(h.notifier.text).toHaveBeenCalledTimes(1);
    expect(await h.db.ownerAttention.count({ where: { reason: 'COST_LIMIT' } })).toBe(2);
  });

  it('a burst of messages is answered once, with all texts in context', async () => {
    await h.business.onMessage(businessMessage({ text: 'Salom' }));
    await h.business.onMessage(businessMessage({ text: 'Menga landing kerak' }));
    await h.business.onMessage(businessMessage({ text: 'Narxi qancha bo‘ladi?' }));
    await h.drain();
    expect(h.sent).toHaveLength(1);
    const call = h.ai.generateReply.mock.calls[0]![0] as { messages: Array<{ parts: Array<{ text?: string }> }> };
    const lastTurn = JSON.stringify(call.messages[call.messages.length - 1]);
    expect(lastTurn).toContain('Menga landing kerak');
    expect(lastTurn).toContain('Narxi qancha');
    expect(await h.db.message.count({ where: { status: 'ANSWERED', direction: 'INCOMING' } })).toBe(3);
  });

  it('Telegram rejection is recorded as FAILED and never retried; unknown outcome is UNCERTAIN', async () => {
    h.senderBehaviour.fail = 'rejected';
    await h.business.onMessage(businessMessage({ text: 'Narxi qancha?' }));
    await h.drain();
    expect((await h.db.aiResponse.findFirstOrThrow()).status).toBe('FAILED');
    h.senderBehaviour.fail = 'unknown';
    await h.business.onMessage(businessMessage({ fromId: 4300, username: 'u2', text: 'Narxi qancha?' }));
    await h.drain();
    expect(await h.db.aiResponse.count({ where: { status: 'UNCERTAIN' } })).toBe(1);
  });

  it('owner actions: let AI reply and manual reply resolve the attention item', async () => {
    await h.business.onMessage(businessMessage({ text: 'Qayerdasan?' }));
    await h.drain();
    const att = await h.db.ownerAttention.findFirstOrThrow();
    expect(await h.pipeline.ownerApprovedAiReply(att.id, OWNER_ID)).toBe('sent');
    expect((await h.db.ownerAttention.findUniqueOrThrow({ where: { id: att.id } })).status).toBe('AI_REPLIED');
    expect(await h.pipeline.ownerApprovedAiReply(att.id, OWNER_ID)).toBe('resolved');

    await h.business.onMessage(businessMessage({ fromId: 7000, username: 'x7', text: 'Kim bilan yuribsan?' }));
    await h.drain();
    const att2 = await h.db.ownerAttention.findFirstOrThrow({ where: { status: 'PENDING' } });
    expect(await h.pipeline.ownerManualReply(att2.id, 'Keyin gaplashamiz', OWNER_ID)).toBe('sent');
    expect(h.sent.at(-1)!.text).toBe('Keyin gaplashamiz');
    expect((await h.db.ownerAttention.findUniqueOrThrow({ where: { id: att2.id } })).status).toBe('REPLIED');
  });

  it('unsupported media without text gets the polite notice', async () => {
    const { fakeMedia } = await import('../support/harness.js');
    h.setMedia(fakeMedia({ statuses: ['UNSUPPORTED'], unsupported: true }));
    await h.business.onMessage(businessMessage({ text: undefined, document: { file_id: 'f', file_unique_id: 'u', file_name: 'x.exe' } }));
    await h.drain();
    expect(h.sent[0]!.text).toContain('ko‘ra olmayman');
  });

  it('voice transcript reaches the classifier and the reply', async () => {
    const { fakeMedia } = await import('../support/harness.js');
    h.setMedia(fakeMedia({ statuses: ['DONE'], summaryText: '[Voice message, 4s] Transcript: "Web sayt narxi qancha?"', transcript: 'Web sayt narxi qancha?' }));
    await h.business.onMessage(businessMessage({ text: undefined, voice: { file_id: 'v', file_unique_id: 'v1', duration: 4 } }));
    await h.drain(['media', 'text']);
    expect(h.sent).toHaveLength(1);
    const call = h.ai.generateReply.mock.calls[0]![0];
    expect(JSON.stringify(call)).toContain('Web sayt narxi qancha?');
  });

  it('messages that waited longer than 30 minutes (assistant offline) go to the owner, not to the AI', async () => {
    const old = businessMessage({ text: 'Saytingiz qancha turadi?', date: Math.floor(Date.now() / 1000) - 2 * 3600 });
    await h.business.onMessage(old);
    await h.drain();
    expect(h.sent).toHaveLength(0);
    expect(h.ai.generateReply).not.toHaveBeenCalled();
    const msg = await h.db.message.findFirstOrThrow({ where: { telegramMessageId: old.message_id } });
    expect(msg.status).toBe('MANUAL');
    expect((await h.db.ownerAttention.findFirstOrThrow()).reason).toBe('STALE');
  });

  it('unauthorized business connections are ignored entirely', async () => {
    await h.connections.upsertFromUpdate({
      id: 'bc-evil',
      user: { id: 999, is_bot: false, first_name: 'Mallory' },
      user_chat_id: 999,
      date: 1,
      is_enabled: true,
      rights: { can_reply: true },
    } as never);
    await h.business.onMessage(businessMessage({ business_connection_id: 'bc-evil', text: 'Salom' }));
    expect(await h.db.message.count()).toBe(0);
  });
});
