import { describe, expect, it, vi } from 'vitest';
import { PROMPT_CANARY, systemCore } from '../../src/conversations/system-core.js';
import { containsSecret, describeError, registerSecrets, sanitizeText } from '../../src/logging/sanitize.js';
import { applyResponsePolicy, toPlainTelegramText } from '../../src/responder/response-policy.js';
import { ContentCipher, DecryptionError, safeEqual } from '../../src/security/crypto.js';
import { assertInside, safeTempPath, sanitizeFileName, sniffMime } from '../../src/security/files.js';
import { cacheReadiness } from '../../src/telegram/common/webhook-server.js';

const ADMIN = 555000111n;
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawz';

describe('response policy (prompt-injection / leak guard)', () => {
  it('passes normal replies and strips markdown', () => {
    const r = applyResponsePolicy('## Narx\n**Landing sahifa** 300$ dan boshlanadi.', { adminTelegramUserId: ADMIN });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('Narx\nLanding sahifa 300$ dan boshlanadi.');
  });

  it('blocks replies that contain the system-prompt canary', () => {
    expect(applyResponsePolicy(`Mana: ${PROMPT_CANARY}`, { adminTelegramUserId: ADMIN })).toMatchObject({ ok: false, violation: 'canary' });
  });

  it('blocks verbatim system prompt fragments', () => {
    const leaked = systemCore('Komron').split('\n').slice(0, 4).join('\n');
    expect(applyResponsePolicy(leaked, { adminTelegramUserId: ADMIN }).ok).toBe(false);
  });

  it('blocks secrets: registered env values and key patterns', () => {
    registerSecrets(['my-very-secret-db-password']);
    expect(applyResponsePolicy('password: my-very-secret-db-password', { adminTelegramUserId: ADMIN }).violation).toBe('secret');
    expect(applyResponsePolicy(`token ${TOKEN}`, { adminTelegramUserId: ADMIN }).violation).toBe('secret');
    expect(applyResponsePolicy('key AIzaSyA1234567890abcdefghijklmnopqrstuv', { adminTelegramUserId: ADMIN }).violation).toBe('secret');
    expect(applyResponsePolicy('sk-proj-abcdefghijklmnop1234', { adminTelegramUserId: ADMIN }).violation).toBe('secret');
  });

  it('blocks the admin user id', () => {
    expect(applyResponsePolicy(`Admin id: ${ADMIN}`, { adminTelegramUserId: ADMIN }).violation).toBe('admin-id');
  });

  it('does not flag ordinary words that look like auth schemes', () => {
    expect(containsSecret('Basic understanding of React is enough')).toBe(false);
    expect(applyResponsePolicy('Basic understanding of React is enough', { adminTelegramUserId: ADMIN }).ok).toBe(true);
  });

  it('rejects empty replies and clamps very long ones', () => {
    expect(applyResponsePolicy('   ', { adminTelegramUserId: ADMIN }).violation).toBe('empty');
    expect(applyResponsePolicy('a'.repeat(5000), { adminTelegramUserId: ADMIN }).text.length).toBeLessThanOrEqual(3500);
  });

  it('removes wrapping quotes and bullets', () => {
    expect(toPlainTelegramText('"Salom!"')).toBe('Salom!');
    expect(toPlainTelegramText('* bir\n* ikki')).toBe('- bir\n- ikki');
  });
});

describe('log sanitizer', () => {
  it('scrubs tokens, keys, bearer headers, URL credentials and query secrets', () => {
    const text = `GET https://api.telegram.org/bot${TOKEN}/getFile Bearer abcdefghijk123 postgresql://user:pass@db/x ?key=XYZ123 AQ.Ab8RN6K8rnN-nPYb9I6S06mejbFMHO9X`;
    const out = sanitizeText(text);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('abcdefghijk123');
    expect(out).not.toContain('user:pass');
    expect(out).not.toContain('XYZ123');
    expect(out).not.toContain('AQ.Ab8RN6');
  });

  it('describeError never includes secrets', () => {
    expect(describeError(new Error(`failed for bot${TOKEN}`))).not.toContain(TOKEN);
  });
});

describe('content encryption at rest', () => {
  const key = Buffer.alloc(32, 9).toString('base64');

  it('round-trips and never stores plaintext', () => {
    const c = new ContentCipher(key);
    const enc = c.encrypt('Salom, bugun ofisda bo‘lasizmi?');
    expect(enc.startsWith('enc:v1:')).toBe(true);
    expect(enc).not.toContain('Salom');
    expect(c.decrypt(enc)).toBe('Salom, bugun ofisda bo‘lasizmi?');
  });

  it('uses a random IV (same text → different ciphertext)', () => {
    const c = new ContentCipher(key);
    expect(c.encrypt('x')).not.toBe(c.encrypt('x'));
  });

  it('wrong key or missing key cannot read data; plaintext legacy values pass through', () => {
    const enc = new ContentCipher(key).encrypt('secret');
    expect(new ContentCipher(Buffer.alloc(32, 1).toString('base64')).decrypt(enc)).toBe('[unreadable]');
    expect(new ContentCipher(undefined).decrypt(enc)).toBe('[encrypted]');
    expect(new ContentCipher(key).decrypt('plain old value')).toBe('plain old value');
    expect(new ContentCipher(undefined).encrypt('x')).toBe('x');
  });

  it('SEC-08: buffer encryption round-trips with a versioned header and never contains the plaintext', () => {
    const c = new ContentCipher(key);
    const data = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('voice note of a contact', 'utf8')]);
    const enc = c.encryptBuffer(data);
    expect(enc.subarray(0, 4).toString('latin1')).toBe('TGAE');
    expect(enc[4]).toBe(1);
    expect(enc.length).toBe(data.length + 4 + 1 + 12 + 16);
    expect(enc.includes(Buffer.from('voice note'))).toBe(false);
    expect(ContentCipher.isEncryptedBuffer(enc)).toBe(true);
    expect(c.decryptBuffer(enc).equals(data)).toBe(true);
    expect(c.encryptBuffer(data).equals(enc)).toBe(false); // random IV
    expect(c.decryptBuffer(c.encryptBuffer(Buffer.alloc(0))).length).toBe(0);
  });

  it('SEC-08: without a key buffers pass through unchanged; legacy plaintext stays readable', () => {
    const data = Buffer.from('raw media bytes');
    const none = new ContentCipher(undefined);
    expect(none.encryptBuffer(data)).toBe(data);
    expect(none.decryptBuffer(data)).toBe(data);
    expect(new ContentCipher(key).decryptBuffer(data).equals(data)).toBe(true);
  });

  it('SEC-08: encrypted buffers cannot be read without the right key, tampered or truncated', () => {
    const enc = new ContentCipher(key).encryptBuffer(Buffer.from('secret media'));
    expect(() => new ContentCipher(undefined).decryptBuffer(enc)).toThrow(DecryptionError);
    expect(() => new ContentCipher(Buffer.alloc(32, 1).toString('base64')).decryptBuffer(enc)).toThrow(DecryptionError);
    const tampered = Buffer.from(enc);
    tampered[tampered.length - 1]! ^= 0xff;
    expect(() => new ContentCipher(key).decryptBuffer(tampered)).toThrow(DecryptionError);
    expect(() => new ContentCipher(key).decryptBuffer(enc.subarray(0, 20))).toThrow(DecryptionError);
    const future = Buffer.from(enc);
    future[4] = 2;
    expect(() => new ContentCipher(key).decryptBuffer(future)).toThrow(/version/);
  });

  it('safeEqual compares in constant time and handles different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('file safety', () => {
  it('sanitizes display file names (no traversal / control chars)', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('..\\..\\windows\\system32\\evil.exe')).toBe('evil.exe');
    expect(sanitizeFileName('a\u0000b<>.pdf')).toBe('a_b__.pdf');
    expect(sanitizeFileName('...')).toBeUndefined();
  });

  it('temp paths are random and stay inside the directory', () => {
    const p = safeTempPath('/tmp/media', '../../x');
    expect(p).toMatch(/[0-9a-f-]{36}\.bin$/);
    expect(() => assertInside('/tmp/media', '/tmp/other/file')).toThrow();
  });

  it('sniffs magic bytes', () => {
    expect(sniffMime(Buffer.from('%PDF-1.7 ...'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from('MZ\x90\x00'))).toBe('application/x-executable');
    expect(sniffMime(Buffer.from('OggS\x00\x02'))).toBe('audio/ogg');
  });
});

describe('readiness cache (SEC-16)', () => {
  it('hits the check at most once per TTL and shares concurrent calls', async () => {
    let t = 0;
    const check = vi.fn(async () => true);
    const ready = cacheReadiness(check, 5_000, () => t);
    expect(await Promise.all([ready(), ready(), ready()])).toEqual([true, true, true]);
    expect(check).toHaveBeenCalledTimes(1);
    t = 4_999;
    expect(await ready()).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
    t = 5_000;
    check.mockResolvedValueOnce(false);
    expect(await ready()).toBe(false);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('treats a throwing check as not ready (and caches that too)', async () => {
    const t = 0;
    const check = vi.fn(async (): Promise<boolean> => {
      throw new Error('db down');
    });
    const ready = cacheReadiness(check, 5_000, () => t);
    expect(await ready()).toBe(false);
    expect(await ready()).toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
