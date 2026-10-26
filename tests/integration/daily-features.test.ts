import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AiRouter } from '../../src/ai/router/types.js';
import type { UserbotAssistantApi } from '../../src/app/userbot-contract.js';
import { OwnerAssistant } from '../../src/assistant/assistant.service.js';
import { BackupService, readBackup } from '../../src/features/backup.service.js';
import { DailyService } from '../../src/features/daily.service.js';
import { StyleService } from '../../src/features/style.service.js';
import { PgQueue } from '../../src/queues/pg-queue.js';
import { cb } from '../../src/telegram/admin/callback-data.js';
import { tzOffsetMs } from '../../src/utils/time.js';
import { businessMessage, buildHarness, OWNER_ID } from '../support/harness.js';
import { createTestDb, hasDb, type TestDb } from './helpers.js';

const d = hasDb ? describe : describe.skip;
const TZ = 'Asia/Tashkent';

/** Local HH:MM in Tashkent, `deltaMin` minutes from now. */
function localClock(deltaMin: number): string {
  const t = new Date(Date.now() + deltaMin * 60_000);
  const local = new Date(t.getTime() + tzOffsetMs(t, TZ));
  return `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
}

const draftsJson = (drafts: string[]) => ({
  result: { text: JSON.stringify({ drafts }), usage: { inputTokens: 1, outputTokens: 1 }, provider: 'gemini' as const, model: 'm', latencyMs: 1 },
  provider: 'gemini' as const,
  model: 'm',
  usedFallback: false,
  costUsd: 0,
});

d('assistant features in the reply pipeline (real PostgreSQL)', () => {
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

  it('scam: never answered, no paid AI call, the owner is warned once per chat', async () => {
    await h.business.onMessage(businessMessage({ text: 'Salom! Sizga Telegramdan SMS kod keldi, shu kodni menga yuborib yuboring' }));
    await h.drain();
    await h.business.onMessage(businessMessage({ text: 'Kod keldimi? Tezroq yuboring kodni, aks holda akkaunt bloklanadi' }));
    await h.drain();
    expect(h.sent).toHaveLength(0);
    expect(h.ai.classify).not.toHaveBeenCalled();
    expect(h.ai.generateReply).not.toHaveBeenCalled();
    const msgs = await h.db.message.findMany({ where: { direction: 'INCOMING' } });
    expect(msgs.every((m) => m.status === 'IGNORED' && m.statusReason?.startsWith('scam'))).toBe(true);
    expect(h.notifier.scamWarning).toHaveBeenCalledTimes(1);
    const warning = h.notifier.scamWarning.mock.calls[0]![0] as unknown as { reasons: string[]; senderTelegramUserId: bigint };
    expect(warning.reasons).toContain('kod yoki parol so‘ralgan');
    expect(warning.senderTelegramUserId).toBe(4242n);
  });

  it('scam protection can be switched off', async () => {
    await h.settings.set('scamProtectionEnabled', false);
    await h.business.onMessage(businessMessage({ text: 'Sizga SMS kod keldi, kodni menga yuboring' }));
    await h.drain();
    expect(h.notifier.scamWarning).not.toHaveBeenCalled();
    expect(h.ai.classify).toHaveBeenCalled();
  });

  it('outside working hours: one notice per night, the owner gets a silent item, no AI reply', async () => {
    await h.settings.set('workHoursEnabled', true);
    await h.settings.set('workStart', localClock(120));
    await h.settings.set('workEnd', localClock(180));
    await h.settings.set('weekendDays', []);
    await h.business.onMessage(businessMessage({ text: 'Salom, sayt narxi qancha?' }));
    await h.drain();
    await h.business.onMessage(businessMessage({ text: 'Javob kutyapman' }));
    await h.drain();
    expect(h.ai.generateReply).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toBe(`Assalomu alaykum! Hozir ish vaqtidan tashqari. Komron ${localClock(120)} dan keyin javob beradi 🙂`);
    const resp = await h.db.aiResponse.findFirstOrThrow();
    expect(resp.kind).toBe('STATUS_NOTICE');
    const items = await h.db.ownerAttention.findMany({ orderBy: { id: 'asc' } });
    expect(items.map((i) => i.reason)).toEqual(['OFF_HOURS', 'OFF_HOURS']);
    const notice = h.notifier.ownerAttention.mock.calls[0]![0] as unknown as { silent?: boolean };
    expect(notice.silent).toBe(true);
  });

  it('outside working hours in AI mode: the AI answers and may mention working hours', async () => {
    await h.settings.set('workHoursEnabled', true);
    await h.settings.set('workStart', localClock(120));
    await h.settings.set('workEnd', localClock(180));
    await h.settings.set('weekendDays', []);
    await h.settings.set('offHoursMode', 'AI');
    await h.business.onMessage(businessMessage({ text: 'Salom, website yasab berasizlarmi?' }));
    await h.drain();
    expect(h.sent).toHaveLength(1);
    const req = h.ai.generateReply.mock.calls[0]![0] as { system: string };
    expect(req.system).toContain('outside Komron\'s working hours');
  });

  it('busy mode: personal questions get the busy notice; the AI may mention it', async () => {
    const until = new Date(Date.now() + 90 * 60_000);
    await h.settings.set('busyUntil', until.toISOString());
    await h.settings.set('busyNote', 'uchrashuvda');
    await h.business.onMessage(businessMessage({ text: 'Qayerdasan?' }));
    await h.drain();
    expect(h.sent[0]!.text).toBe(`Komron hozir band (uchrashuvda). Taxminan ${localClock(90)} dan keyin javob beradi 🙂`);

    await h.business.onMessage(businessMessage({ fromId: 5151, username: 'vali', text: 'Salom, website yasab berasizlarmi?' }));
    await h.drain();
    const req = h.ai.generateReply.mock.calls.at(-1)![0] as { system: string };
    expect(req.system).toContain('set "busy" mode');
    expect(req.system).toContain('(uchrashuvda)');
  });

  it('contact language: Russian contacts get Russian notices and a Russian reply instruction', async () => {
    await h.business.onMessage(businessMessage({ text: 'Где ты сейчас?' }));
    await h.drain();
    expect(h.sent[0]!.text).toBe('Это личный вопрос. Komron ответит вам сам чуть позже 🙂');

    h.aiState.classification = { category: 'BUSINESS', confidence: 0.95, requires_owner: false, reason: 'price' };
    await h.business.onMessage(businessMessage({ fromId: 6161, username: 'ivan', text: 'Здравствуйте, сколько стоит сайт?' }));
    await h.drain();
    const req = h.ai.generateReply.mock.calls.at(-1)![0] as { system: string };
    expect(req.system).toContain('write your whole reply in Russian');
  });

  it('reply drafts: stored encrypted, shown in the notification, sent with the owner reply path', async () => {
    h.ai.classify.mockResolvedValueOnce(draftsJson(['Ha, kelaman 👍', 'Bugun bo‘lmaydi, ertaga-chi?', 'Keyinroq aytaman']) as never);
    await h.business.onMessage(businessMessage({ text: 'Ertaga kelasizmi?' }));
    await h.drain();
    const att = await h.db.ownerAttention.findFirstOrThrow();
    expect(att.suggestions).toMatch(/^enc:v1:/);
    const notice = h.notifier.ownerAttention.mock.calls[0]![0] as unknown as { suggestions: string[] };
    expect(notice.suggestions).toEqual(['Ha, kelaman 👍', 'Bugun bo‘lmaydi, ertaga-chi?', 'Keyinroq aytaman']);
    const item = await h.attention.get(att.id);
    expect(item!.suggestions[1]).toBe('Bugun bo‘lmaydi, ertaga-chi?');
    // The waiting notice was sent first; the chosen draft goes out as the owner's reply.
    expect(await h.pipeline.ownerManualReply(att.id, item!.suggestions[1]!, OWNER_ID)).toBe('sent');
    expect(h.sent.at(-1)!.text).toBe('Bugun bo‘lmaydi, ertaga-chi?');
    expect((await h.db.ownerAttention.findUniqueOrThrow({ where: { id: att.id } })).status).toBe('REPLIED');
  });

  it('reply drafts never block the owner item when the AI fails', async () => {
    h.aiState.failClassify = 'error';
    await h.business.onMessage(businessMessage({ text: 'Ertaga kelasizmi?' }));
    await h.drain();
    const att = await h.db.ownerAttention.findFirstOrThrow();
    expect(att.suggestions).toBeNull();
    expect(h.notifier.ownerAttention).toHaveBeenCalledTimes(1);
  });
});

d('daily routines (real PostgreSQL)', () => {
  let tdb: TestDb;
  let h: Awaited<ReturnType<typeof buildHarness>>;
  let now: Date;
  let daily: DailyService;
  let userbotReady: boolean;

  const fakeUserbot = (): UserbotAssistantApi => ({
    isReady: () => userbotReady,
    presence: async () => new Map(),
    resolveUsername: async () => null,
    searchPeople: async () => [],
    birthdays: async () => [{ id: 777n, firstName: 'Vali', birthday: '1995-10-27' }],
  });

  beforeEach(async () => {
    if (tdb) await tdb.drop();
    tdb = await createTestDb();
    h = await buildHarness(tdb.db);
    now = new Date('2026-10-27T03:30:00Z'); // 08:30 in Tashkent
    userbotReady = true;
    const ai = h.ai as unknown as AiRouter;
    daily = new DailyService({
      db: h.db,
      ai,
      cipher: h.cipher,
      settings: h.settings,
      notifier: h.notifier as never,
      attention: h.attention,
      backup: new BackupService({ db: h.db, cipher: h.cipher, timezone: TZ, now: () => now }),
      style: new StyleService({ db: h.db, ai, cipher: h.cipher, settings: h.settings, now: () => now }),
      userbot: () => fakeUserbot(),
      button: (...args) => cb('as', ...args),
      timezone: TZ,
      now: () => now,
    });
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  const texts = () => h.notifier.text.mock.calls.map((c) => String(c[0]));

  it('morning summary + birthday greetings once a day; a ready greeting can be sent with ✅', async () => {
    await h.db.telegramUser.create({ data: { telegramUserId: 888n, firstName: 'Ali', birthday: '10-27', birthdaySource: 'owner' } });
    await h.db.assistantTask.create({
      data: { kind: 'REMINDER', text: h.cipher.encrypt('Onamga qo‘ng‘iroq'), runAt: new Date('2026-10-27T13:00:00Z'), active: true, confirmed: true },
    });
    h.aiState.reply = 'Tug‘ilgan kuningiz bilan! 🎉';

    await daily.tick();
    await daily.tick(); // the same day again: nothing new

    const summary = texts().find((t) => t.includes('Xayrli tong'))!;
    expect(summary).toContain('27-oktabr, seshanba');
    expect(summary).toContain('Onamga qo‘ng‘iroq');
    expect(summary).toContain('Bugun tug‘ilgan kun');
    expect(summary).toContain('Ali');
    expect(summary).toContain('Vali'); // synced from the owner's Telegram contacts
    expect(texts().filter((t) => t.includes('Xayrli tong'))).toHaveLength(1);

    const greetings = h.notifier.text.mock.calls.filter((c) => String(c[0]).includes('tug‘ilgan kuni!'));
    expect(greetings).toHaveLength(2);
    const opts = (greetings[0] as unknown[])[1] as { buttons: Array<Array<{ label: string; data: string }>> };
    const send = opts.buttons[0]![0]!;
    expect(send.label).toBe('✅ Yuborish');
    const draftId = Number(send.data.split('|')[2]);
    const draft = await h.db.assistantTask.findUniqueOrThrow({ where: { id: draftId } });
    expect(draft).toMatchObject({ kind: 'SEND_MESSAGE', active: false, confirmed: false });
    expect(h.cipher.decrypt(draft.text)).toBe('Tug‘ilgan kuningiz bilan! 🎉');
    const vali = await h.db.telegramUser.findFirstOrThrow({ where: { telegramUserId: 777n } });
    expect(vali).toMatchObject({ birthday: '1995-10-27', birthdaySource: 'telegram', birthdayNotifiedYear: 2026 });
  });

  it('without the userbot the greeting is offered for copy-paste; the summary waits for its time', async () => {
    userbotReady = false;
    await h.settings.set('morningSummaryTime', '09:00');
    await h.db.telegramUser.create({ data: { telegramUserId: 888n, firstName: 'Ali', birthday: '1990-10-27', birthdaySource: 'owner' } });
    h.aiState.reply = 'Tabriklayman!';
    await daily.tick();
    expect(texts().some((t) => t.includes('Xayrli tong'))).toBe(false);
    now = new Date('2026-10-27T04:05:00Z'); // 09:05
    await daily.tick();
    const greeting = texts().find((t) => t.includes('tug‘ilgan kuni!'))!;
    expect(greeting).toContain('<code>Tabriklayman!</code>');
    expect(await h.db.assistantTask.count({ where: { kind: 'SEND_MESSAGE' } })).toBe(0);
  });

  it('a late start still greets birthdays (summary skipped); 29 February is greeted on 28 February', async () => {
    now = new Date('2027-02-28T12:00:00Z'); // 17:00 local, 9 hours after the summary time; 2027 is not a leap year
    await h.db.telegramUser.create({ data: { telegramUserId: 888n, firstName: 'Ali', birthday: '02-29', birthdaySource: 'owner' } });
    h.aiState.reply = 'Tabriklayman!';
    await daily.tick();
    expect(texts().some((t) => t.includes('Xayrli tong'))).toBe(false);
    expect(texts().filter((t) => t.includes('tug‘ilgan kuni!'))).toHaveLength(1);
  });

  it('a failed Telegram birthday sync is retried on the next tick', async () => {
    let fail = true;
    const base = fakeUserbot();
    const api: UserbotAssistantApi = {
      ...base,
      birthdays: async () => {
        if (fail) throw new Error('FLOOD_WAIT');
        return base.birthdays!();
      },
    };
    const ai = h.ai as unknown as AiRouter;
    const d2 = new DailyService({
      db: h.db, ai, cipher: h.cipher, settings: h.settings, notifier: h.notifier as never, attention: h.attention,
      backup: new BackupService({ db: h.db, cipher: h.cipher, timezone: TZ }), style: new StyleService({ db: h.db, ai, cipher: h.cipher, settings: h.settings }),
      userbot: () => api, button: (...args) => cb('as', ...args), timezone: TZ, now: () => now,
    });
    await expect(d2.syncTelegramBirthdays()).rejects.toThrow('FLOOD_WAIT');
    fail = false;
    expect(await d2.syncTelegramBirthdays()).toBe(1);
    expect(await d2.syncTelegramBirthdays()).toBe(0); // once a day
  });

  it('busy mode ends by itself and the owner is told once', async () => {
    await daily.setBusy(new Date(now.getTime() + 60_000), 'uchrashuvda');
    await h.settings.set('morningSummaryEnabled', false);
    await h.settings.set('birthdayRemindersEnabled', false);
    await h.settings.set('dailyBackupEnabled', false);
    await daily.tick();
    expect(texts().some((t) => t.includes('tugadi'))).toBe(false);
    now = new Date(now.getTime() + 2 * 60_000);
    await daily.tick();
    await daily.tick();
    expect(texts().filter((t) => t.includes('«Bandman» rejimi tugadi'))).toHaveLength(1);
    expect((await h.settings.get()).busyUntil).toBeNull();
  });

  it('nightly backup: one encrypted file per day that the server key can open', async () => {
    await h.business.onMessage(businessMessage({ text: 'Salom' }));
    await h.settings.set('morningSummaryEnabled', false);
    await h.settings.set('birthdayRemindersEnabled', false);
    await daily.tick();
    await daily.tick();
    expect(h.notifier.document).toHaveBeenCalledTimes(1);
    const [file, filename, caption] = h.notifier.document.mock.calls[0]! as unknown as [Buffer, string, string];
    expect(filename).toBe('backup-2026-10-27.json.gz.enc');
    expect(caption).toContain('Shifrlangan');
    expect(() => JSON.parse(file.toString('utf8'))).toThrow(); // not readable without the key
    const opened = readBackup(h.cipher, file);
    expect(opened.format).toBe(1);
    expect(opened.counts.users).toBe(1);
    expect(opened.counts.messages).toBe(1);
    expect(opened.data.settings!.some((r) => r.key === 'backupDoneOn')).toBe(true);
  });

  it('style learning: needs 20 own messages, then saves a profile used by replies', async () => {
    const style = new StyleService({ db: h.db, ai: h.ai as unknown as AiRouter, cipher: h.cipher, settings: h.settings });
    expect(await style.learn()).toMatchObject({ ok: false, reason: 'too_few' });
    for (let i = 0; i < 22; i++)
      await h.business.onMessage(businessMessage({ from: { id: Number(OWNER_ID), is_bot: false, first_name: 'Komron' }, text: `xop, ${i} da gaplashamiz` }));
    h.aiState.reply = '- short, lowercase\n- says "xop"';
    const result = await style.learn();
    expect(result).toMatchObject({ ok: true, messages: 22 });
    const req = h.ai.generateReply.mock.calls.at(-1)![0] as { messages: Array<{ parts: Array<{ text: string }> }> };
    expect(req.messages[0]!.parts[0]!.text).toContain('xop, 21 da gaplashamiz');
    expect((await h.settings.get()).styleProfile).toBe('- short, lowercase\n- says "xop"');

    h.aiState.reply = 'Ha, bo‘ladi';
    await h.business.onMessage(businessMessage({ fromId: 5151, username: 'vali', text: 'Salom, website yasab berasizlarmi?' }));
    await h.drain();
    const reply = h.ai.generateReply.mock.calls.at(-1)![0] as { system: string };
    expect(reply.system).toContain('says "xop"');
  });

  it('assistant: "2 soat uchrashuvdaman" turns busy mode on; "Alining tug‘ilgan kuni 12-mart" is saved', async () => {
    const ai = h.ai as unknown as AiRouter;
    const assistant = new OwnerAssistant({
      db: h.db, ai, cipher: h.cipher, notifier: h.notifier as never, queue: new PgQueue(h.db),
      sendAsOwner: async () => 1, timezone: TZ, daily, settings: h.settings, now: () => now,
    });
    const intent = (o: Record<string, unknown>) =>
      h.ai.classify.mockResolvedValueOnce({
        result: {
          text: JSON.stringify({ action: 'chat', person: '', repeat: false, remind_at: '', text: '', task_id: 0, reply: '', needs_search: false, channel: '', exact: false, start_at: '', end_at: '', ...o }),
          usage: { inputTokens: 1, outputTokens: 1 }, provider: 'gemini', model: 'm', latencyMs: 1,
        },
        provider: 'gemini', model: 'm', usedFallback: false, costUsd: 0,
      } as never);

    intent({ action: 'busy_set', end_at: '2026-10-27T10:30:00+05:00', text: 'uchrashuvda' });
    const busy = await assistant.handleText('2 soat uchrashuvdaman');
    expect(busy.text).toContain('10:30 gacha');
    expect(busy.text).toContain('Komron hozir band (uchrashuvda)');
    expect((await h.settings.get()).busyUntil).toBe('2026-10-27T05:30:00.000Z');
    expect((await assistant.handleAction(['busy', 'off'])).text).toContain('o‘chirildi');
    expect((await h.settings.get()).busyUntil).toBeNull();

    await h.db.telegramUser.create({ data: { telegramUserId: 888n, firstName: 'Ali', username: 'ali_dev' } });
    intent({ action: 'birthday_set', person: '@ali_dev', text: '12-mart', start_at: '2026-03-12T00:00:00+05:00' });
    const saved = await assistant.handleText('@ali_dev ning tug‘ilgan kuni 12-mart');
    expect(saved.text).toContain('12-mart');
    expect((await h.db.telegramUser.findFirstOrThrow({ where: { telegramUserId: 888n } })).birthday).toBe('03-12');
  });
});


