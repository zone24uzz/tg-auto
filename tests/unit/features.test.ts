import { describe, expect, it } from 'vitest';
import { buildReplyContext } from '../../src/conversations/context-builder.js';
import { availabilityOf, availabilitySection, fillNotice, isWorkingTime } from '../../src/features/availability.js';
import { decodeDrafts, encodeDrafts } from '../../src/features/drafts.js';
import { detectLanguage, languageInstruction } from '../../src/features/language.js';
import { latinToCyrillic, localizeNotice } from '../../src/features/notices.js';
import { detectScam, SCAM_THRESHOLD } from '../../src/features/scam.js';
import { normalizeIntent } from '../../src/assistant/intent.js';
import { ContentCipher } from '../../src/security/crypto.js';
import { buildDefaultSettings } from '../../src/settings/schema.js';
import { testEnv } from '../support/env.js';

const TZ = 'Asia/Tashkent'; // UTC+5, no DST
/** A local Tashkent time on a given weekday of the week of 2026-10-26 (Monday). */
const at = (weekday: number, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number);
  const day = 26 + ((weekday + 6) % 7); // Monday 26th … Sunday 1st (Nov)
  return new Date(Date.UTC(2026, 9, day, h! - 5, m!));
};

describe('contact language detection', () => {
  it.each([
    ['Salom, sayt qancha turadi?', 'uz-latn'],
    ['Assalomu alaykum, bugun bo‘lasizmi', 'uz-latn'],
    ['Ассалому алайкум, қалайсиз?', 'uz-cyrl'],
    ['Салом, нима гап', 'uz-cyrl'],
    ['Здравствуйте, сколько стоит сайт?', 'ru'],
    ['Hello, how much does a website cost?', 'en'],
  ])('%s → %s', (text, lang) => {
    expect(detectLanguage(text)).toBe(lang);
  });

  it('too little to tell → null (the model decides)', () => {
    expect(detectLanguage('👍')).toBeNull();
    expect(detectLanguage('https://example.com')).toBeNull();
    expect(languageInstruction(null)).toBe('');
    expect(languageInstruction('ru')).toContain('Russian');
  });
});

describe('notices in the contact language', () => {
  it('transliterates Uzbek Latin to Cyrillic, keeping placeholders and links', () => {
    expect(latinToCyrillic('Salom! O‘zim yozaman, ertaga {start} dan keyin. https://x.uz/a')).toBe(
      'Салом! Ўзим ёзаман, эртага {start} дан кейин. https://x.uz/a',
    );
    expect(latinToCyrillic('Shoshilmang, choy iching')).toBe('Шошилманг, чой ичинг');
  });

  it('default texts get built-in translations; edited texts stay as written', () => {
    const s = buildDefaultSettings(testEnv());
    const owner = s.ownerName;
    expect(localizeNotice('personal', s.personalReplyText, owner, 'ru')).toContain('личный вопрос');
    expect(localizeNotice('personal', s.personalReplyText, owner, 'en')).toContain('personal question');
    expect(localizeNotice('personal', 'Mening matnim', owner, 'ru')).toBe('Mening matnim');
    expect(localizeNotice('personal', 'Keyin yozaman', owner, 'uz-cyrl')).toBe('Кейин ёзаман');
    expect(localizeNotice('personal', 'Keyin yozaman', owner, 'uz-latn')).toBe('Keyin yozaman');
  });
});

describe('working hours and busy mode', () => {
  const s = { workStart: '09:00', workEnd: '21:00', weekendDays: [0] };

  it('day range and days off', () => {
    expect(isWorkingTime(s, at(1, '10:00'), TZ)).toBe(true);
    expect(isWorkingTime(s, at(1, '08:59'), TZ)).toBe(false);
    expect(isWorkingTime(s, at(1, '21:00'), TZ)).toBe(false);
    expect(isWorkingTime(s, at(0, '12:00'), TZ)).toBe(false); // Sunday off
  });

  it('overnight shift belongs to the day it started', () => {
    const night = { workStart: '20:00', workEnd: '04:00', weekendDays: [0] };
    expect(isWorkingTime(night, at(1, '23:00'), TZ)).toBe(true);
    expect(isWorkingTime(night, at(2, '03:00'), TZ)).toBe(true); // Monday's shift
    expect(isWorkingTime(night, at(1, '03:00'), TZ)).toBe(false); // Sunday's shift (day off)
    expect(isWorkingTime(night, at(1, '12:00'), TZ)).toBe(false);
  });

  it('availability: busy only while in the future; off hours only when enabled', () => {
    const now = at(1, '22:00');
    const base = { ...s, workHoursEnabled: false, busyUntil: null, busyNote: '' };
    expect(availabilityOf(base, now, TZ)).toEqual({ busy: null, offHours: false, nextStart: null });
    const off = availabilityOf({ ...base, workHoursEnabled: true }, now, TZ);
    expect(off).toMatchObject({ offHours: true, nextStart: '09:00' });
    const until = new Date(now.getTime() + 3_600_000);
    const busy = availabilityOf({ ...base, busyUntil: until.toISOString(), busyNote: 'uchrashuvda' }, now, TZ);
    expect(busy.busy).toEqual({ until, note: 'uchrashuvda' });
    expect(availabilityOf({ ...base, busyUntil: new Date(now.getTime() - 1).toISOString() }, now, TZ).busy).toBeNull();
    const section = availabilitySection(busy, 'Komron', TZ);
    expect(section).toContain('busy');
    expect(section).toContain('23:00');
    expect(availabilitySection({ busy: null, offHours: false, nextStart: null }, 'Komron', TZ)).toBe('');
  });

  it('fills notice placeholders (no note → no empty brackets)', () => {
    const until = at(1, '16:30');
    expect(fillNotice('{owner} hozir band ({note}). {until} dan keyin.', { owner: 'Komron', note: 'uchrashuvda', until, timezone: TZ })).toBe(
      'Komron hozir band (uchrashuvda). 16:30 dan keyin.',
    );
    expect(fillNotice('{owner} hozir band ({note}). {until} dan keyin.', { owner: 'Komron', until, timezone: TZ })).toBe(
      'Komron hozir band. 16:30 dan keyin.',
    );
    expect(fillNotice('{start} dan keyin', { owner: 'K', start: '09:00', timezone: TZ })).toBe('09:00 dan keyin');
  });
});

describe('scam detection', () => {
  it.each([
    'Salom! Sizga telegramdan SMS kod keldi, shu kodni menga yuborib yuboring iltimos',
    'Здравствуйте, вам пришел код подтверждения, скиньте его мне',
    'Kartangiz raqami va amal qilish muddatini yuboring, CVV ham kerak',
    'Kuniga 5% foyda! USDT investitsiya, kafolatlangan daromad',
    'Bepul Telegram Premium! https://tg-premium-gift.xyz/claim',
    'Airdrop boshlandi: https://bit.ly/3abc kripto hamyoningizni ulang',
  ])('flags: %s', (text) => {
    const v = detectScam(text);
    expect(v.score).toBeGreaterThanOrEqual(SCAM_THRESHOLD);
    expect(v.reasons.length).toBeGreaterThan(0);
  });

  it.each([
    'Salom, sayt yasab berasizmi? Narxi qancha?',
    'Mana mening saytim: https://example.uz',
    'Bonus haqida keyin gaplashamiz',
    'Investitsiya loyihamiz uchun landing kerak edi',
    'Ertaga uchrashamizmi?',
    'Kod yozishni bilasizmi? React kerak',
    'Kirish kodi emailingizga yuborildi, tekshirib ko‘ring',
    'Telegram kodi keldi, rahmat, kirdim',
  ])('does not flag: %s', (text) => {
    expect(detectScam(text).score).toBeLessThan(SCAM_THRESHOLD);
  });
});

describe('reply prompt: language, style and owner status', () => {
  it('adds the detected language, the learned style and the owner-set status', () => {
    const settings = { ...buildDefaultSettings(testEnv()), styleProfile: '- short, lowercase\n- uses "xop"' };
    const built = buildReplyContext({
      settings,
      ownerPrompt: 'Be helpful.',
      history: [],
      currentText: 'Сколько стоит?',
      injectionSuspected: false,
      timezone: TZ,
      language: 'ru',
      availability: '## Status\nbusy until 16:00',
    });
    expect(built.system).toContain('write your whole reply in Russian');
    expect(built.system).toContain('uses "xop"');
    expect(built.system).toContain('busy until 16:00');
    // The status section comes after the immutable core, which allows only owner-set status.
    expect(built.system.indexOf('busy until')).toBeGreaterThan(built.system.indexOf('NON-NEGOTIABLE'));
    expect(built.system).toContain('The only exception: a status section below');
  });

  it('a disabled style profile is not used', () => {
    const settings = { ...buildDefaultSettings(testEnv()), styleProfile: 'SECRET-STYLE', useStyleProfile: false };
    const built = buildReplyContext({ settings, ownerPrompt: '', history: [], currentText: 'hi', injectionSuspected: false, timezone: TZ });
    expect(built.system).not.toContain('SECRET-STYLE');
  });
});

describe('reply drafts storage and new owner commands', () => {
  it('drafts are stored encrypted and decoded defensively', () => {
    const cipher = new ContentCipher(Buffer.alloc(32, 3).toString('base64'));
    const stored = encodeDrafts(cipher, ['Ha, kelaman', 'Yo‘q, bugun bo‘lmaydi']);
    expect(stored).toMatch(/^enc:v1:/);
    expect(decodeDrafts(cipher, stored)).toEqual(['Ha, kelaman', 'Yo‘q, bugun bo‘lmaydi']);
    expect(encodeDrafts(cipher, [])).toBeNull();
    expect(decodeDrafts(cipher, cipher.encrypt('not json'))).toEqual([]);
    expect(decodeDrafts(cipher, null)).toEqual([]);
  });

  it('busy / birthday intents keep their dates', () => {
    const now = new Date('2026-10-26T06:00:00Z');
    const busy = normalizeIntent({ action: 'busy_set', end_at: '2026-10-26T13:00:00+05:00', text: 'uchrashuvda' }, now);
    expect(busy).toMatchObject({ action: 'busy_set', text: 'uchrashuvda', endAt: new Date('2026-10-26T08:00:00Z') });
    const bd = normalizeIntent({ action: 'birthday_set', person: 'Ali', start_at: '2026-03-12T00:00:00+05:00', text: '12-mart' }, now);
    expect(bd).toMatchObject({ action: 'birthday_set', person: 'Ali', startAt: new Date('2026-03-11T19:00:00Z') });
  });
});
