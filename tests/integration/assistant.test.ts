import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenceState, ResolvedTelegramUser, UserbotAssistantApi } from '../../src/app/userbot-contract.js';
import { OwnerAssistant } from '../../src/assistant/assistant.service.js';
import { normalizeIntent } from '../../src/assistant/intent.js';
import { PgQueue } from '../../src/queues/pg-queue.js';
import { ContentCipher } from '../../src/security/crypto.js';
import { fakeAi, fakeNotifier } from '../support/harness.js';
import { createTestDb, hasDb, type TestDb } from './helpers.js';

const d = hasDb ? describe : describe.skip;
const FIRDAVS = 5_550_001n;
const KEY = Buffer.alloc(32, 7).toString('base64');

function intent(over: Record<string, unknown>) {
  return JSON.stringify({ action: 'unknown', person: '', repeat: false, remind_at: '', text: '', task_id: 0, reply: '', ...over });
}

function fakeUserbot(people: ResolvedTelegramUser[] = []) {
  const state = { ready: true, presence: new Map<bigint, PresenceState>() };
  const api: UserbotAssistantApi = {
    isReady: () => state.ready,
    presence: vi.fn(async (users: Array<{ id: bigint }>) => new Map(users.filter((u) => state.presence.has(u.id)).map((u) => [u.id, state.presence.get(u.id)!]))),
    resolveUsername: vi.fn(async (u: string) => people.find((p) => p.username?.toLowerCase() === u.toLowerCase()) ?? null),
    searchPeople: vi.fn(async (q: string) => people.filter((p) => `${p.firstName ?? ''} ${p.lastName ?? ''}`.toLowerCase().includes(q.toLowerCase()))),
  };
  return { api, state };
}

d('owner assistant (real PostgreSQL)', () => {
  let tdb: TestDb;
  let assistant: OwnerAssistant;
  let ai: ReturnType<typeof fakeAi>;
  let notes: ReturnType<typeof fakeNotifier>;
  let userbot: ReturnType<typeof fakeUserbot>;
  let sentAsOwner: Array<{ chatId: bigint; text: string }>;
  let now: Date;

  const say = (json: string) => ai.raw.classify.mockResolvedValueOnce({ result: { text: json, usage: { inputTokens: 1, outputTokens: 1 }, provider: 'gemini', model: 'm', latencyMs: 1 }, provider: 'gemini', model: 'm', usedFallback: false, costUsd: 0, reasoningEffort: 'low' } as never);
  const texts = () => notes.calls.filter((c) => c.method === 'text').map((c) => String(c.args));

  beforeEach(async () => {
    if (tdb) await tdb.drop();
    tdb = await createTestDb();
    ai = fakeAi();
    notes = fakeNotifier();
    userbot = fakeUserbot([{ id: FIRDAVS, accessHash: '123', firstName: 'Firdavs', lastName: 'Karimov', username: 'firdavs_k', isContact: true }]);
    sentAsOwner = [];
    now = new Date('2026-10-08T10:00:00Z');
    assistant = new OwnerAssistant({
      db: tdb.db,
      ai: ai.ai,
      cipher: new ContentCipher(KEY),
      notifier: notes.notifier,
      queue: new PgQueue(tdb.db),
      sendAsOwner: async (chatId, text) => {
        sentAsOwner.push({ chatId, text });
        return 1;
      },
      timezone: 'Asia/Tashkent',
      now: () => now,
    });
    assistant.attachUserbot(userbot.api);
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('"Firdavs online bo‘lsa xabar ber": found via contacts, notifies once on offline → online', async () => {
    userbot.state.presence.set(FIRDAVS, 'offline');
    say(intent({ action: 'watch_online', person: 'Firdavs' }));
    const reply = await assistant.handleText('Firdavs online bo‘lsa menga xabar ber');
    expect(reply.text).toContain('Firdavs Karimov');
    const task = await tdb.db.assistantTask.findFirstOrThrow();
    expect(task).toMatchObject({ kind: 'WATCH_ONLINE', targetTelegramUserId: FIRDAVS, active: true, repeat: false, lastPresence: 'offline' });
    // The person found through Telegram is stored with the access hash.
    expect((await tdb.db.telegramUser.findFirstOrThrow({ where: { telegramUserId: FIRDAVS } })).accessHash).toBe('123');

    await assistant.onPresence(FIRDAVS, 'offline');
    expect(texts()).toHaveLength(0);
    await assistant.onPresence(FIRDAVS, 'online');
    await assistant.onPresence(FIRDAVS, 'online'); // duplicate push
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('online');
    expect((await tdb.db.assistantTask.findFirstOrThrow()).active).toBe(false);
  });

  it('repeat watch respects the cooldown and needs an offline → online transition', async () => {
    say(intent({ action: 'watch_online', person: '@firdavs_k', repeat: true }));
    await assistant.handleText('har safar @firdavs_k kirsa ayt');
    await assistant.onPresence(FIRDAVS, 'online');
    await assistant.onPresence(FIRDAVS, 'offline');
    now = new Date(now.getTime() + 5 * 60_000);
    await assistant.onPresence(FIRDAVS, 'online'); // within 30 min cooldown
    expect(texts()).toHaveLength(1);
    await assistant.onPresence(FIRDAVS, 'offline');
    now = new Date(now.getTime() + 31 * 60_000);
    await assistant.onPresence(FIRDAVS, 'online');
    expect(texts()).toHaveLength(2);
    expect((await tdb.db.assistantTask.findFirstOrThrow()).active).toBe(true);
  });

  it('tick polls presence for watched people', async () => {
    say(intent({ action: 'watch_online', person: 'Firdavs' }));
    await assistant.handleText('Firdavs kirganda ayt');
    userbot.state.presence.set(FIRDAVS, 'online');
    await assistant.tick();
    expect(texts()).toHaveLength(1);
  });

  it('hidden last-seen is reported to the owner', async () => {
    userbot.state.presence.set(FIRDAVS, 'recently');
    say(intent({ action: 'watch_online', person: 'Firdavs' }));
    const reply = await assistant.handleText('Firdavs online bo‘lsa ayt');
    expect(reply.text).toContain('last seen');
  });

  it('watch_message notifies when the person writes', async () => {
    say(intent({ action: 'watch_message', person: 'Firdavs' }));
    await assistant.handleText('Firdavs yozsa darhol ayt');
    await assistant.onIncomingMessage({ telegramUserId: 42n, label: 'Boshqa', preview: 'salom' });
    expect(texts()).toHaveLength(0);
    await assistant.onIncomingMessage({ telegramUserId: FIRDAVS, label: 'Firdavs', preview: 'aka qayerdasiz <b>' });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('aka qayerdasiz &lt;b&gt;');
  });

  it('reminder: stored encrypted, job enqueued for runAt, fires once', async () => {
    say(intent({ action: 'remind', remind_at: '2026-10-08T18:00:00+05:00', text: 'onamga qo‘ng‘iroq' }));
    const reply = await assistant.handleText('soat 18 da onamga qo‘ng‘iroq qilishni eslat');
    expect(reply.text).toContain('onamga');
    const task = await tdb.db.assistantTask.findFirstOrThrow();
    expect(task.text).toMatch(/^enc:v1:/);
    const job = await tdb.db.job.findFirstOrThrow({ where: { type: 'assistant.remind' } });
    expect(job.runAt.toISOString()).toBe('2026-10-08T13:00:00.000Z');
    await assistant.runReminder(task.id);
    await assistant.runReminder(task.id);
    expect(texts()).toEqual([expect.stringContaining('onamga qo‘ng‘iroq')]);
  });

  it('send_message waits for ✅ and sends exactly once', async () => {
    say(intent({ action: 'send_message', person: 'Firdavs', text: 'ertaga 10 da uchrashamiz' }));
    const reply = await assistant.handleText('Firdavsga yoz: ertaga 10 da uchrashamiz');
    expect(sentAsOwner).toHaveLength(0);
    const send = reply.buttons?.flat().find((b) => b.data.startsWith('as|send|'));
    expect(send).toBeDefined();
    const args = send!.data.split('|').slice(1);
    const [first, second] = await Promise.all([assistant.handleAction(args), assistant.handleAction(args)]);
    expect(sentAsOwner).toEqual([{ chatId: FIRDAVS, text: 'ertaga 10 da uchrashamiz' }]);
    expect([first.text, second.text].some((t) => t.includes('allaqachon'))).toBe(true);
  });

  it('cancel by person and list', async () => {
    say(intent({ action: 'watch_online', person: 'Firdavs' }));
    await assistant.handleText('Firdavs kirsa ayt');
    say(intent({ action: 'list_tasks' }));
    expect((await assistant.handleText('vazifalarim')).text).toContain('Firdavs Karimov');
    say(intent({ action: 'cancel_task', person: 'Firdavs' }));
    expect((await assistant.handleText('Firdavs kuzatuvini o‘chir')).text).toContain('1 ta vazifa o‘chirildi');
    expect(await tdb.db.assistantTask.count({ where: { active: true } })).toBe(0);
  });

  it('ambiguous names offer a choice; picking creates the task', async () => {
    await tdb.db.telegramUser.createMany({
      data: [
        { telegramUserId: 9001n, firstName: 'Ali', lastName: 'Valiyev' },
        { telegramUserId: 9002n, firstName: 'Ali', lastName: 'Karimov' },
      ],
    });
    say(intent({ action: 'watch_message', person: 'Ali' }));
    const reply = await assistant.handleText('Ali yozsa ayt');
    const picks = reply.buttons!.flat().filter((b) => b.data.startsWith('as|pick|'));
    expect(picks).toHaveLength(2);
    await assistant.handleAction(picks[1]!.data.split('|').slice(1));
    const task = await tdb.db.assistantTask.findFirstOrThrow({ where: { active: true } });
    expect(task.targetTelegramUserId).toBe(9002n);
  });

  it('online watch needs the userbot', async () => {
    userbot.state.ready = false;
    say(intent({ action: 'watch_online', person: 'Firdavs' }));
    expect((await assistant.handleText('Firdavs kirsa ayt')).text).toContain('userbot');
  });

  it('unknown person and AI failure give a helpful answer', async () => {
    say(intent({ action: 'watch_message', person: 'Zarina' }));
    expect((await assistant.handleText('Zarina yozsa ayt')).text).toContain('topa olmadim');
    ai.raw.classify.mockRejectedValueOnce(new Error('down'));
    expect((await assistant.handleText('nimadir')).text).toContain('tushuna olmadim');
  });
});

describe('normalizeIntent', () => {
  const now = new Date('2026-10-08T10:00:00Z');
  it('drops past / far-future reminders and quotes around names', () => {
    expect(normalizeIntent({ action: 'remind', remind_at: '2026-10-07T10:00:00Z' }, now).remindAt).toBeUndefined();
    expect(normalizeIntent({ action: 'remind', remind_at: '2028-10-07T10:00:00Z' }, now).remindAt).toBeUndefined();
    expect(normalizeIntent({ action: 'remind', remind_at: '2026-10-08T18:00:00+05:00' }, now).remindAt?.toISOString()).toBe('2026-10-08T13:00:00.000Z');
    expect(normalizeIntent({ action: 'watch_online', person: '«Firdavs»' }, now).person).toBe('Firdavs');
    expect(normalizeIntent({ action: 'cancel_task', task_id: 3 }, now).taskId).toBe(3);
  });
});
