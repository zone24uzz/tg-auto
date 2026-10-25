import { describe, expect, it, vi } from 'vitest';
import type { AssistantStatus } from '../../src/assistant/assistant.service.js';
import { ADMIN_ID, baseDeps, callsOf, createTestBot, messageUpdate } from './helpers.js';

describe('assistant live status in the admin chat', () => {
  it('shows what the assistant is doing, then turns that message into the answer', async () => {
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
    const { bot, calls } = createTestBot(deps);
    await bot.handleUpdate(messageUpdate(ADMIN_ID, 'Bugun dollar kursi qancha?'));

    const sent = callsOf(calls, 'sendMessage');
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.payload.text)).toContain('O‘ylayapman');
    const edits = callsOf(calls, 'editMessageText');
    expect(edits.some((e) => String(e.payload.text).includes('Google’dan qidiryapman'))).toBe(true);
    const last = edits.at(-1)!;
    expect(last.payload.text).toBe('Javob tayyor ✅');
    expect(last.payload.message_id).toBe(edits[0]!.payload.message_id);
  });
});
