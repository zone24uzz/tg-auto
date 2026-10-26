import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnerAssistant } from '../../src/assistant/assistant.service.js';
import { CalendarService } from '../../src/google/calendar.service.js';
import { PgQueue } from '../../src/queues/pg-queue.js';
import { ContentCipher } from '../../src/security/crypto.js';
import { runWithTenant } from '../../src/tenancy/context.js';
import { TenantService } from '../../src/tenancy/tenant.service.js';
import { fakeAi, fakeNotifier } from '../support/harness.js';
import { TEST_ADMIN_ID } from '../support/env.js';
import { createTestDb, hasDb, type TestDb } from './helpers.js';

const d = hasDb ? describe : describe.skip;
const cipher = new ContentCipher(Buffer.alloc(32, 7).toString('base64'));
const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;

d('Google Calendar (real PostgreSQL, fake Google)', () => {
  let tdb: TestDb;
  let tenants: TenantService;
  let notes: ReturnType<typeof fakeNotifier>;
  let calendar: CalendarService;
  let google: ReturnType<typeof vi.fn>;
  let now: Date;
  let events: Array<Record<string, unknown>>;

  beforeEach(async () => {
    if (tdb) await tdb.drop();
    tdb = await createTestDb();
    tenants = new TenantService(tdb.db);
    await tenants.ensureSuperAdmin(TEST_ADMIN_ID); // tenant #1 = the test scope
    notes = fakeNotifier();
    now = new Date('2026-10-26T06:00:00Z');
    events = [];
    google = vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        const body = new URLSearchParams(String(init?.body));
        if (body.get('grant_type') === 'authorization_code')
          return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, id_token: idToken('kama@gmail.com') });
        return json({ access_token: 'at-2', expires_in: 3600 });
      }
      if (url.includes('/calendars/primary/events') && init?.method === 'POST') {
        const b = JSON.parse(String(init.body)) as { summary: string; start: { dateTime: string }; end: { dateTime: string } };
        return json({ id: 'ev-new', summary: b.summary, start: b.start, end: b.end });
      }
      if (url.includes('/calendars/primary/events')) return json({ items: events });
      return json({}, 404);
    });
    calendar = new CalendarService({
      db: tdb.db,
      cipher,
      tenants,
      notifier: notes.notifier,
      clientId: 'cid.apps.googleusercontent.com',
      clientSecret: 'secret-xyz-123',
      publicUrl: 'https://bot.example.com',
      stateSecret: 'state-secret',
      superAdminId: TEST_ADMIN_ID,
      timezone: 'Asia/Tashkent',
      fetchImpl: google as unknown as typeof fetch,
      now: () => now,
    });
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  const connect = async () => {
    const link = new URL(calendar.connectUrl());
    expect(link.searchParams.get('redirect_uri')).toBe('https://bot.example.com/oauth/google/callback');
    expect(link.searchParams.get('access_type')).toBe('offline');
    const state = link.searchParams.get('state')!;
    return calendar.handleCallback(new URL(`https://bot.example.com/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`));
  };

  it('OAuth: signed state, tokens stored encrypted, the owner is told', async () => {
    const res = await connect();
    expect(res.status).toBe(200);
    const acc = await tdb.db.googleAccount.findFirstOrThrow();
    expect(acc.email).toBe('kama@gmail.com');
    expect(acc.refreshToken).toMatch(/^enc:v1:/);
    expect(cipher.decrypt(acc.refreshToken)).toBe('rt-1');
    expect(String(notes.calls.at(-1)!.args)).toContain('Google Calendar ulandi');
  });

  it('rejects a forged or expired state', async () => {
    const state = calendar.signState(1);
    const forged = state.replace(/^1\./, '2.');
    expect((await calendar.handleCallback(new URL(`https://x/cb?code=a&state=${encodeURIComponent(forged)}`))).status).toBe(400);
    now = new Date(now.getTime() + 16 * 60_000);
    expect((await calendar.handleCallback(new URL(`https://x/cb?code=a&state=${encodeURIComponent(state)}`))).status).toBe(400);
    expect(await tdb.db.googleAccount.count()).toBe(0);
  });

  it('only the super-admin’s workspace may connect', async () => {
    const other = await tdb.db.tenant.create({ data: { telegramUserId: 4242n, status: 'ACTIVE' } });
    const state = calendar.signState(other.id);
    expect((await calendar.handleCallback(new URL(`https://x/cb?code=a&state=${encodeURIComponent(state)}`))).status).toBe(403);
    await runWithTenant({ tenantId: other.id, ownerTelegramUserId: 4242n, language: 'uz' }, async () => expect(calendar.allowed()).toBe(false));
  });

  it('lists events with a fresh token (refreshes an expired one) and reminds once', async () => {
    await connect();
    now = new Date(now.getTime() + 2 * 3_600_000); // the access token expired
    events = [{ id: 'ev1', summary: 'Ali bilan uchrashuv', start: { dateTime: new Date(now.getTime() + 20 * 60_000).toISOString() }, end: { dateTime: new Date(now.getTime() + 80 * 60_000).toISOString() } }];
    const list = await calendar.listEvents(now, new Date(now.getTime() + 3_600_000));
    expect(list.map((e) => e.summary)).toEqual(['Ali bilan uchrashuv']);
    expect(google.mock.calls.some(([u, i]) => String(u).includes('/token') && String((i as RequestInit).body).includes('refresh_token'))).toBe(true);
    await calendar.remindUpcoming();
    await calendar.remindUpcoming();
    const reminders = notes.calls.filter((c) => String(c.args).includes('daqiqadan keyin'));
    expect(reminders).toHaveLength(1);
    expect(String(reminders[0]!.args)).toContain('20 daqiqadan keyin');
  });

  it('assistant: "ertaga 15:00 ga … qo‘sh" asks first, then adds the event', async () => {
    await connect();
    const ai = fakeAi();
    const assistant = new OwnerAssistant({
      db: tdb.db, ai: ai.ai, cipher, notifier: notes.notifier, queue: new PgQueue(tdb.db),
      sendAsOwner: async () => 1, timezone: 'Asia/Tashkent', calendar, now: () => now,
    });
    ai.raw.classify.mockResolvedValueOnce({
      result: { text: JSON.stringify({ action: 'calendar_add', person: '', repeat: false, remind_at: '', text: 'Ali bilan uchrashuv', task_id: 0, reply: '', needs_search: false, channel: '', exact: false, start_at: '2026-10-27T15:00:00+05:00', end_at: '' }), usage: { inputTokens: 1, outputTokens: 1 }, provider: 'gemini', model: 'm', latencyMs: 1 },
      provider: 'gemini', model: 'm', usedFallback: false, costUsd: 0,
    } as never);
    const ask = await assistant.handleText('Ertaga 15:00 ga Ali bilan uchrashuv qo‘sh');
    expect(ask.text).toContain('Kalendarga qo‘shaymi');
    expect(google.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'POST' && String((i as RequestInit).body).includes('summary'))).toBe(false);
    const done = await assistant.handleAction(['cal', 'ok', '0']);
    expect(done.text).toContain('Kalendarga qo‘shildi');
    const post = google.mock.calls.find(([u, i]) => String(u).includes('/events') && (i as RequestInit | undefined)?.method === 'POST')!;
    const body = JSON.parse(String((post[1] as RequestInit).body)) as { start: { dateTime: string }; end: { dateTime: string } };
    expect(body.start.dateTime).toBe('2026-10-27T10:00:00.000Z');
    expect(body.end.dateTime).toBe('2026-10-27T11:00:00.000Z');
  });
});
