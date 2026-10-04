import type { Message } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseEnv } from '../../src/config/env.js';
import { cb, parseCb } from '../../src/telegram/admin/callback-data.js';
import { normalizeBusinessMessage } from '../../src/telegram/main/normalizer.js';
import { localDateKey, nextLocalTime, startOfDayInTz } from '../../src/utils/time.js';
import { testEnv } from '../support/env.js';

const base = {
  message_id: 10,
  date: 1_760_000_000,
  chat: { id: 42, type: 'private', first_name: 'Ali' },
  from: { id: 42, is_bot: false, first_name: 'Ali', username: 'ali' },
  business_connection_id: 'bc-1',
} as unknown as Message;

describe('normalizeBusinessMessage', () => {
  it('returns null without a business connection', () => {
    expect(normalizeBusinessMessage({ ...base, business_connection_id: undefined } as Message)).toBeNull();
  });

  it('normalizes text messages', () => {
    const n = normalizeBusinessMessage({ ...base, text: 'Salom' } as Message)!;
    expect(n).toMatchObject({ connectionId: 'bc-1', telegramMessageId: 10, chatId: 42n, type: 'TEXT', text: 'Salom', sentByBusinessBot: false });
    expect(n.sender?.telegramUserId).toBe(42n);
  });

  it('picks the largest photo and keeps the caption', () => {
    const n = normalizeBusinessMessage({
      ...base,
      caption: 'Bu yerda nima xato?',
      photo: [
        { file_id: 's', file_unique_id: 's1', width: 90, height: 90 },
        { file_id: 'l', file_unique_id: 'l1', width: 1280, height: 720, file_size: 1000 },
      ],
    } as Message)!;
    expect(n.type).toBe('PHOTO');
    expect(n.media[0]).toMatchObject({ kind: 'PHOTO', fileId: 'l', width: 1280 });
    expect(n.caption).toBe('Bu yerda nima xato?');
  });

  it('handles voice, video notes, documents (sanitized names), stickers and forwards', () => {
    expect(normalizeBusinessMessage({ ...base, voice: { file_id: 'v', file_unique_id: 'v1', duration: 7 } } as Message)!.type).toBe('VOICE');
    const vn = normalizeBusinessMessage({ ...base, video_note: { file_id: 'n', file_unique_id: 'n1', length: 384, duration: 12 } } as Message)!;
    expect(vn.media[0]).toMatchObject({ kind: 'VIDEO_NOTE', durationSec: 12, width: 384 });
    const doc = normalizeBusinessMessage({ ...base, document: { file_id: 'd', file_unique_id: 'd1', file_name: '../../evil.pdf' } } as Message)!;
    expect(doc.media[0]!.fileName).toBe('evil.pdf');
    const st = normalizeBusinessMessage({ ...base, sticker: { file_id: 's', file_unique_id: 's1', type: 'regular', width: 1, height: 1, is_animated: false, is_video: false, emoji: '😂' } } as Message)!;
    expect(st.text).toBe('[sticker 😂]');
    const fw = normalizeBusinessMessage({ ...base, text: 'x', forward_origin: { type: 'hidden_user', sender_user_name: 'Bob', date: 1 } } as Message)!;
    expect(fw.forward).toMatchObject({ originType: 'hidden_user', senderName: 'Bob' });
  });

  it('marks messages sent by a business bot', () => {
    const n = normalizeBusinessMessage({ ...base, text: 'x', sender_business_bot: { id: 1, is_bot: true, first_name: 'b' } } as Message)!;
    expect(n.sentByBusinessBot).toBe(true);
  });
});

describe('env validation', () => {
  it('accepts a minimal valid config', () => {
    expect(testEnv().ADMIN_TELEGRAM_USER_ID).toBeTypeOf('bigint');
  });

  it('never echoes secret values in errors', () => {
    try {
      parseEnv({ DATABASE_URL: 'x', TELEGRAM_BOT_TOKEN: 'super-secret-but-invalid', ADMIN_TELEGRAM_USER_ID: 'abc' });
      throw new Error('should fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain('super-secret-but-invalid');
      expect((error as Error).message).toContain('TELEGRAM_BOT_TOKEN');
    }
  });

  it('webhook mode requires https URL and a secret; production requires an encryption key', () => {
    expect(() => testEnv({ TELEGRAM_UPDATE_MODE: 'webhook' })).toThrow(/TELEGRAM_WEBHOOK_URL/);
    expect(() => testEnv({ TELEGRAM_UPDATE_MODE: 'webhook', TELEGRAM_WEBHOOK_URL: 'http://x', TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(20) })).toThrow(/https/);
    expect(() => testEnv({ NODE_ENV: 'production', DATA_ENCRYPTION_KEY: '' })).toThrow(/DATA_ENCRYPTION_KEY/);
  });
});

describe('callback data', () => {
  it('encodes/decodes and enforces the 64-byte limit', () => {
    expect(parseCb(cb('oa.r', 123))).toEqual({ route: 'oa.r', args: ['123'] });
    expect(() => cb('x', 'a'.repeat(70))).toThrow(/too long/);
    expect(() => cb('x', 'a|b')).toThrow(/separator/);
  });
});

describe('timezone helpers', () => {
  it('computes local midnight in Asia/Tashkent (UTC+5)', () => {
    const now = new Date('2026-10-04T02:30:00Z'); // 07:30 local
    expect(startOfDayInTz(now, 'Asia/Tashkent').toISOString()).toBe('2026-10-03T19:00:00.000Z');
    expect(localDateKey(now, 'Asia/Tashkent')).toBe('2026-10-04');
    expect(nextLocalTime(now, 'Asia/Tashkent', 8).toISOString()).toBe('2026-10-04T03:00:00.000Z');
  });
});
