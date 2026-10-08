import { Api } from 'telegram';
import { describe, expect, it } from 'vitest';
import { presenceOf } from '../../src/telegram/userbot/presence.js';

describe('presenceOf', () => {
  it('maps Telegram user statuses', () => {
    expect(presenceOf(new Api.UserStatusOnline({ expires: 0 }))).toBe('online');
    expect(presenceOf(new Api.UserStatusOffline({ wasOnline: 0 }))).toBe('offline');
    expect(presenceOf(new Api.UserStatusRecently({}))).toBe('recently');
    expect(presenceOf(new Api.UserStatusLastWeek({}))).toBe('hidden');
    expect(presenceOf(new Api.UserStatusEmpty())).toBe('hidden');
    expect(presenceOf(undefined)).toBe('hidden');
  });
});
