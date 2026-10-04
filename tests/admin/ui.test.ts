import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/database/client.js';
import { parseCommand } from '../../src/telegram/admin/dispatch.js';
import { parseCallbackValue, parseTextValue, FIELDS } from '../../src/telegram/admin/fields.js';
import { AdminStateStore, INPUT_TTL_MS } from '../../src/telegram/admin/state.js';
import { Kb, callbackData, fit, label, loadPage, pageArg, paginate } from '../../src/telegram/admin/ui.js';
import { pauseTarget, statusLine } from '../../src/telegram/admin/views/auto-reply.js';
import { parseRuleTarget } from '../../src/telegram/admin/views/lists.js';
import { parseTags } from '../../src/telegram/admin/views/users.js';
import { fakeAdminStateTable } from './helpers.js';

describe('paginate', () => {
  it('computes pages, skip and clamps out-of-range pages', () => {
    expect(paginate(0, 0, 10)).toEqual({ page: 0, pages: 1, skip: 0, take: 10, total: 0 });
    expect(paginate(25, 2, 10)).toEqual({ page: 2, pages: 3, skip: 20, take: 10, total: 25 });
    expect(paginate(25, 9, 10).page).toBe(2);
    expect(paginate(25, -3, 10).page).toBe(0);
    expect(paginate(10, 1, 10)).toMatchObject({ page: 0, pages: 1 });
    expect(paginate(11, 1, 10)).toMatchObject({ page: 1, pages: 2, skip: 10 });
    expect(paginate(5, Number.NaN, 2).page).toBe(0);
    expect(paginate(5, 1, 0).take).toBe(1);
  });

  it('parses page args defensively', () => {
    expect(pageArg(undefined)).toBe(0);
    expect(pageArg('3')).toBe(3);
    expect(pageArg('-1')).toBe(0);
    expect(pageArg('abc')).toBe(0);
    expect(pageArg('99999999')).toBe(0);
  });

  it('loadPage falls back to the last page when the requested one vanished', async () => {
    const fetch = vi.fn(async (take: number, skip: number) => ({ items: [skip, take].filter(() => skip < 5), total: 5 }));
    const res = await loadPage(7, 2, fetch);
    expect(res.info).toMatchObject({ page: 2, pages: 3, skip: 4 });
    expect(fetch).toHaveBeenLastCalledWith(2, 4);
    const ok = await loadPage(1, 2, fetch);
    expect(fetch).toHaveBeenLastCalledWith(2, 2);
    expect(ok.info.page).toBe(1);
  });

  it('pager buttons only offer existing pages', () => {
    const first = callbackData(new Kb().pager(paginate(30, 0, 10), (p) => `x|${p}`).build());
    expect(first).toEqual(['nop', 'x|1']);
    const middle = callbackData(new Kb().pager(paginate(30, 1, 10), (p) => `x|${p}`).build());
    expect(middle).toEqual(['x|0', 'nop', 'x|2']);
    const single = callbackData(new Kb().pager(paginate(3, 0, 10), (p) => `x|${p}`).build());
    expect(single).toEqual([]);
  });
});

describe('text helpers', () => {
  it('fit escapes and keeps the escaped HTML within the budget', () => {
    const html = fit('<&>'.repeat(1000), 100);
    expect(html.length).toBeLessThanOrEqual(101);
    expect(html).not.toMatch(/<(?!i>|\/i>)/);
    expect(fit(null, 10)).toContain('bo‘sh');
    expect(fit('salom', 100)).toBe('salom');
  });

  it('label never splits an emoji into a lone surrogate', () => {
    const out = label('😀'.repeat(100), 10);
    expect(Array.from(out)).toHaveLength(10);
    expect(out.endsWith('…')).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });

  it('parses commands with bot mentions and arguments', () => {
    expect(parseCommand('/pause 30')).toEqual({ name: 'pause', arg: '30' });
    expect(parseCommand('/Menu@test_admin_bot')).toEqual({ name: 'menu', arg: '' });
    expect(parseCommand('salom')).toBeNull();
  });

  it('parses list targets, tags and setting values', () => {
    expect(parseRuleTarget(' 12345 ')).toEqual({ matchType: 'USER_ID', value: '12345' });
    expect(parseRuleTarget('@Ali_V')).toEqual({ matchType: 'USERNAME', value: '@Ali_V' });
    expect(parseRuleTarget('#friends')).toEqual({ matchType: 'TAG', value: '#friends' });
    expect(parseTags('friends, contact  vip')).toEqual(['friends', 'contact', 'vip']);
    expect(parseTags('-')).toEqual([]);
    expect(parseCallbackValue(FIELDS.ae!, '0')).toBe(false);
    expect(parseCallbackValue(FIELDS.pt!, '0.7')).toBe(0.7);
    expect(() => parseCallbackValue(FIELDS.ae!, 'x')).toThrow();
    expect(parseTextValue(FIELDS.mc!, '1,5')).toBe(1.5);
    expect(parseTextValue(FIELDS.csp!, '-')).toBe('');
    expect(parseTextValue(FIELDS.tv!, '-')).toBeNull();
    expect(() => parseTextValue(FIELDS.mc!, 'abc')).toThrow();
  });
});

describe('auto reply helpers', () => {
  const tz = 'Asia/Tashkent';
  const now = new Date('2026-10-04T10:00:00Z'); // 15:00 in Tashkent

  it('computes pause targets', () => {
    expect(pauseTarget('15', now, tz)?.toISOString()).toBe('2026-10-04T10:15:00.000Z');
    expect(pauseTarget('0', now, tz)).toBeNull();
    expect(pauseTarget('tm', now, tz)?.toISOString()).toBe('2026-10-05T03:00:00.000Z'); // 08:00 local
    expect(pauseTarget('9999', now, tz)).toBeUndefined();
    expect(pauseTarget('x', now, tz)).toBeUndefined();
  });

  it('formats the status line', () => {
    expect(statusLine({ autoReplyEnabled: false, pausedUntil: null }, now, tz)).toBe('🔴 OFF');
    expect(statusLine({ autoReplyEnabled: true, pausedUntil: null }, now, tz)).toBe('🟢 ON');
    expect(statusLine({ autoReplyEnabled: true, pausedUntil: '2026-10-04T11:30:00.000Z' }, now, tz)).toBe('🟡 PAUSED until 16:30');
    expect(statusLine({ autoReplyEnabled: true, pausedUntil: '2026-10-04T09:00:00.000Z' }, now, tz)).toBe('🟢 ON');
  });
});

describe('AdminStateStore', () => {
  it('stores, reads, expires and clears pending input', async () => {
    const table = fakeAdminStateTable();
    let now = new Date('2026-10-04T10:00:00Z');
    const store = new AdminStateStore({ adminState: table } as unknown as Db, INPUT_TTL_MS, () => now);
    await store.set(1n, 'pr.edit', { back: 'pr', n: 2 });
    expect(await store.get(1n)).toMatchObject({ state: 'pr.edit', payload: { back: 'pr', n: 2 } });
    now = new Date(now.getTime() + INPUT_TTL_MS + 1);
    expect(await store.get(1n)).toBeNull();
    expect(table.rows.size).toBe(0);
    await store.set(1n, 'x');
    expect(await store.clear(1n)).toBe(true);
    expect(await store.clear(1n)).toBe(false);
  });
});
