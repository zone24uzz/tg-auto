import { describe, expect, it } from 'vitest';
import { parseQuickCommand } from '../../src/assistant/quick.js';

const now = new Date('2026-10-27T09:09:00Z');

describe('owner commands understood without AI', () => {
  it.each([
    ['qara 10 minutga timer qoyib ber', 10 * 60_000],
    ['10 daqiqadan keyin eslat', 10 * 60_000],
    ['2 soatdan keyin eslat: onamga qo‘ng‘iroq', 2 * 3_600_000],
    ['1,5 soatga taymer', 90 * 60_000],
    ['напомни через 30 минут', 30 * 60_000],
    ['remind me in 45 minutes', 45 * 60_000],
  ])('%s → reminder', (text, ms) => {
    const intent = parseQuickCommand(text, now);
    expect(intent?.action).toBe('remind');
    expect(intent!.remindAt!.getTime() - now.getTime()).toBe(ms);
  });

  it('keeps the reminder text after ":"', () => {
    expect(parseQuickCommand('2 soatdan keyin eslat: onamga qo‘ng‘iroq', now)?.text).toBe('onamga qo‘ng‘iroq');
    expect(parseQuickCommand('10 minutga timer', now)?.text).toContain('Taymer');
  });

  it('greetings get an instant answer', () => {
    expect(parseQuickCommand('hello', now)).toMatchObject({ action: 'chat' });
    expect(parseQuickCommand('Assalomu alaykum!', now)?.reply).toContain('Salom');
  });

  it.each(['soat 18:00 da eslat', 'timer nima?', '10 ta post yoz', 'Firdavs online bo‘lsa xabar ber', 'hello, kanalga post yoz', 'eslat'])(
    'leaves the rest to the AI: %s',
    (text) => {
      expect(parseQuickCommand(text, now)).toBeNull();
    },
  );
});
