import { describe, expect, it, vi } from 'vitest';
import type { AssistantStatus } from '../../src/assistant/assistant.service.js';
import { ADMIN_ID, baseDeps, callsOf, createTestBot, messageUpdate } from './helpers.js';

function setup() {
  const { deps } = baseDeps();
  const assistant = {
    handleText: vi.fn(async (_text: string, onStatus?: (s: AssistantStatus) => void) => {
      onStatus?.('thinking');
      onStatus?.('searching');
      return { text: 'Javob tayyor ✅' };
    }),
    handleAction: vi.fn(),
  };
  Object.assign(deps, { assistant });
  return createTestBot(deps);
}

describe('assistant live status in the admin chat', () => {
  it('streams the status as a message draft (smooth native animation), then sends the answer', async () => {
    const { bot, calls } = setup();
    await bot.handleUpdate(messageUpdate(ADMIN_ID, 'Bugun dollar kursi qancha?'));
    await vi.waitFor(() => expect(callsOf(calls, 'sendMessage').some((c) => c.payload.text === 'Javob tayyor ✅')).toBe(true));

    const drafts = callsOf(calls, 'sendMessageDraft');
    expect(String(drafts[0]!.payload.text)).toContain('O‘ylayapman');
    expect(drafts.some((d) => String(d.payload.text).includes('Google’dan qidiryapman'))).toBe(true);
    expect(new Set(drafts.map((d) => d.payload.draft_id)).size).toBe(1); // one draft, animated in place
    expect(callsOf(calls, 'sendChatAction').length).toBeGreaterThan(0); // native "typing…"
    expect(callsOf(calls, 'editMessageText')).toHaveLength(0);
  });

  it('falls back to editing one message when drafts are unavailable', async () => {
    const { bot, calls } = setup();
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (method === 'sendMessageDraft') throw new Error('Bad Request: method is unavailable');
      return prev(method, payload, signal);
    });
    await bot.handleUpdate(messageUpdate(ADMIN_ID, 'Bugun dollar kursi qancha?'));
    await vi.waitFor(() => expect(callsOf(calls, 'editMessageText').some((e) => e.payload.text === 'Javob tayyor ✅')).toBe(true));
    const status = callsOf(calls, 'sendMessage');
    expect(String(status[0]!.payload.text)).toContain('O‘ylayapman');
    const last = callsOf(calls, 'editMessageText').at(-1)!;
    expect(last.payload.text).toBe('Javob tayyor ✅');
  });
});
