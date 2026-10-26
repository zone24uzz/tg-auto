import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnerAssistant } from '../../src/assistant/assistant.service.js';
import { ChannelService } from '../../src/channels/channel.service.js';
import { PgQueue } from '../../src/queues/pg-queue.js';
import { ContentCipher } from '../../src/security/crypto.js';
import { runAsSystem, runWithTenant } from '../../src/tenancy/context.js';
import { fakeAi, fakeNotifier } from '../support/harness.js';
import { TEST_TENANT_ID } from '../support/tenant-scope.js';
import { TEST_ADMIN_ID } from '../support/env.js';
import { createTestDb, hasDb, type TestDb } from './helpers.js';

const d = hasDb ? describe : describe.skip;
const CHANNEL_ID = -1001234567890;
const KEY = Buffer.alloc(32, 7).toString('base64');

function membership(status: 'administrator' | 'left' | 'kicked', canPost = true, fromId = Number(TEST_ADMIN_ID)) {
  return {
    chat: { id: CHANNEL_ID, type: 'channel', title: 'KAMA News', username: 'kama_news' },
    from: { id: fromId, is_bot: false, first_name: 'Owner' },
    date: 0,
    old_chat_member: { status: 'left', user: { id: 1, is_bot: true, first_name: 'bot' } },
    new_chat_member: { status, user: { id: 1, is_bot: true, first_name: 'bot' }, ...(status === 'administrator' ? { can_post_messages: canPost } : {}) },
  } as never;
}

d('channel posts (real PostgreSQL)', () => {
  let tdb: TestDb;
  let ai: ReturnType<typeof fakeAi>;
  let notes: ReturnType<typeof fakeNotifier>;
  let api: { sendMessage: ReturnType<typeof vi.fn>; leaveChat: ReturnType<typeof vi.fn>; getChatMember: ReturnType<typeof vi.fn> };
  let channels: ChannelService;
  let assistant: OwnerAssistant;
  const cipher = new ContentCipher(KEY);
  const texts = () => notes.calls.filter((c) => c.method === 'text').map((c) => String(c.args));
  const nextPost = (text: string) =>
    ai.raw.generateReply.mockResolvedValueOnce({
      result: { text, usage: { inputTokens: 1, outputTokens: 1 }, provider: 'gemini', model: 'm', latencyMs: 1 },
      provider: 'gemini', model: 'm', usedFallback: false, costUsd: 0,
    } as never);
  const say = (json: Record<string, unknown>) =>
    ai.raw.classify.mockResolvedValueOnce({
      result: { text: JSON.stringify({ action: 'unknown', person: '', repeat: false, remind_at: '', text: '', task_id: 0, reply: '', needs_search: false, channel: '', exact: false, ...json }), usage: { inputTokens: 1, outputTokens: 1 }, provider: 'gemini', model: 'm', latencyMs: 1 },
      provider: 'gemini', model: 'm', usedFallback: false, costUsd: 0,
    } as never);
  const buttonsOf = (reply: { buttons?: Array<Array<{ data: string }>> }) => (reply.buttons ?? []).flat().map((b) => b.data);

  beforeEach(async () => {
    if (tdb) await tdb.drop();
    tdb = await createTestDb();
    ai = fakeAi();
    notes = fakeNotifier();
    api = { sendMessage: vi.fn(async () => ({ message_id: 42 })), leaveChat: vi.fn(async () => true), getChatMember: vi.fn(async () => ({ status: 'creator' })) };
    channels = new ChannelService({ db: tdb.db, ai: ai.ai, cipher, api: api as never, notifier: notes.notifier, button: (v, id) => `as|cp|${v}|${id}` });
    assistant = new OwnerAssistant({
      db: tdb.db, ai: ai.ai, cipher, notifier: notes.notifier, queue: new PgQueue(tdb.db),
      sendAsOwner: async () => 1, timezone: 'Asia/Tashkent', channels,
    });
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adding the bot as an admin connects the channel to that workspace only', async () => {
    await channels.onMembership(membership('administrator'));
    expect(texts()[0]).toContain('Kanal ulandi');
    expect(await channels.list()).toHaveLength(1);
    // Another workspace does not see it.
    await runWithTenant({ tenantId: TEST_TENANT_ID + 1, ownerTelegramUserId: 999n, language: 'uz' }, async () => {
      expect(await channels.list()).toEqual([]);
      expect((await channels.listReply()).text).toContain('Hali kanal ulanmagan');
    });
  });

  it('a channel added by someone without a workspace is left immediately', async () => {
    await runAsSystem(() => channels.onMembership(membership('administrator')));
    expect(api.leaveChat).toHaveBeenCalledWith(CHANNEL_ID);
    expect(await runAsSystem(() => tdb.db.channel.count())).toBe(0);
  });

  it('without the post right the owner is told what to enable', async () => {
    await channels.onMembership(membership('administrator', false));
    expect(texts()[0]).toContain('Xabar joylash');
    say({ action: 'channel_post', text: 'yangi xizmat haqida' });
    expect((await assistant.handleText('Kanalga post yoz: yangi xizmat haqida')).text).toContain('Hali kanal ulanmagan');
  });

  it('draft → ✅ publishes exactly once (double click) with a link', async () => {
    await channels.onMembership(membership('administrator'));
    say({ action: 'channel_post', text: 'yangi landing xizmatimiz haqida' });
    nextPost('🚀 Yangi xizmat: landing sahifalar 3 kunda!');
    const statuses: string[] = [];
    const draft = await assistant.handleText('Kanalga post yoz: yangi landing xizmatimiz haqida', (s) => statuses.push(s));
    expect(statuses).toEqual(['thinking', 'writing']);
    expect(draft.text).toContain('Post loyihasi');
    expect(draft.text).toContain('landing sahifalar');
    expect(api.sendMessage).not.toHaveBeenCalled();
    const ok = buttonsOf(draft).find((b) => b.startsWith('as|cp|ok|'))!;
    const args = ok.split('|').slice(1);
    const [first, second] = await Promise.all([assistant.handleAction(args), assistant.handleAction(args)]);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith(CHANNEL_ID, '🚀 Yangi xizmat: landing sahifalar 3 kunda!', expect.anything());
    expect([first.text, second.text].join(' ')).toContain('https://t.me/kama_news/42');
    expect([first.text, second.text].join(' ')).toContain('allaqachon');
  });

  it('exact text is kept as-is; ✏️ then the next message revises the draft; ❌ cancels', async () => {
    await channels.onMembership(membership('administrator'));
    say({ action: 'channel_post', text: 'Bugun soat 18:00 da jonli efir!', exact: true });
    const draft = await assistant.handleText('Kanalga joyla: Bugun soat 18:00 da jonli efir!');
    expect(draft.text).toContain('Bugun soat 18:00 da jonli efir!');
    expect(ai.raw.generateReply).not.toHaveBeenCalled();
    const postId = Number(buttonsOf(draft).find((b) => b.startsWith('as|cp|ok|'))!.split('|')[3]);

    expect((await assistant.handleAction(['cp', 'ed', String(postId)])).text).toContain('Qanday o‘zgartiray');
    nextPost('⏰ Bugun 18:00 — jonli efir! Savollaringizni tayyorlang.');
    const revised = await assistant.handleText('oxiriga savollar haqida qo‘sh');
    expect(revised.text).toContain('Savollaringizni tayyorlang');
    expect(ai.raw.classify).toHaveBeenCalledTimes(1); // the change request did not go through intent parsing

    expect((await assistant.handleAction(['cp', 'no', String(postId)])).text).toContain('bekor');
    expect((await assistant.handleAction(['cp', 'ok', String(postId)])).text).toContain('allaqachon');
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('a news post needs web search: with search the draft is grounded, without it nothing is invented', async () => {
    await channels.onMembership(membership('administrator'));
    say({ action: 'channel_post', text: 'AI haqida yangilik', needs_search: true });
    ai.raw.generateReply.mockResolvedValueOnce({
      result: { text: '🤖 AI yangiligi: …', usage: { inputTokens: 1, outputTokens: 1 }, provider: 'gemini', model: 'm', latencyMs: 1, sources: [{ url: 'https://news.example/ai', title: 'news' }] },
      provider: 'gemini', model: 'm', usedFallback: false, costUsd: 0,
    } as never);
    const statuses: string[] = [];
    const draft = await assistant.handleText('Kanalga post yoz: AI haqida yangilik top', (s) => statuses.push(s));
    expect(statuses).toEqual(['thinking', 'searching']);
    expect(ai.raw.generateReply).toHaveBeenCalledWith(expect.objectContaining({ webSearch: true }));
    expect(draft.text).toContain('Manbalar (postga qo‘shilmaydi)');

    // Search refused (no quota): the next news request is declined instead of inventing news.
    say({ action: 'channel_post', text: 'yana yangilik', needs_search: true });
    ai.raw.generateReply.mockRejectedValueOnce(new Error('gemini HTTP 429: quota'));
    expect((await assistant.handleText('Kanalga post yoz: yana yangilik')).text).toContain('AI hozir javob bermadi');
    say({ action: 'channel_post', text: 'yana yangilik', needs_search: true });
    const declined = await assistant.handleText('Kanalga post yoz: yana yangilik');
    expect(declined.text).toContain('Yangilik to‘qib chiqarmayman');
    expect(ai.raw.generateReply).toHaveBeenCalledTimes(2);
  });

  it('several channels: the owner picks one', async () => {
    await channels.onMembership(membership('administrator'));
    await tdb.db.channel.create({ data: { telegramChatId: -1009, title: 'Ikkinchi kanal', addedByTelegramUserId: TEST_ADMIN_ID, canPost: true } });
    say({ action: 'channel_post', text: 'salom' });
    const ask = await assistant.handleText('Kanalga post yoz: salom');
    expect(ask.text).toContain('Qaysi kanalga');
    const pick = buttonsOf(ask).find((b) => b.startsWith('as|cp|pick|'))!;
    nextPost('👋 Salom!');
    const draft = await assistant.handleAction(pick.split('|').slice(1));
    expect(draft.text).toContain('Post loyihasi');
  });

  it('an owner who lost their channel rights can no longer post (checked at publish time)', async () => {
    await channels.onMembership(membership('administrator'));
    say({ action: 'channel_post', text: 'Bugun aksiya!', exact: true });
    const draft = await assistant.handleText('Kanalga joyla: Bugun aksiya!');
    const ok = buttonsOf(draft).find((b) => b.startsWith('as|cp|ok|'))!;
    api.getChatMember.mockResolvedValueOnce({ status: 'member' });
    const reply = await assistant.handleAction(ok.split('|').slice(1));
    expect(reply.text).toContain('huquqiga ega admin emassiz');
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.getChatMember).toHaveBeenCalledWith(CHANNEL_ID, Number(TEST_ADMIN_ID));
    expect(await channels.list()).toEqual([]);
  });

  it('removing the bot deactivates the channel', async () => {
    await channels.onMembership(membership('administrator'));
    await channels.onMembership(membership('left'));
    expect(await channels.list()).toEqual([]);
    expect(texts().at(-1)).toContain('olib tashlandi');
  });
});
