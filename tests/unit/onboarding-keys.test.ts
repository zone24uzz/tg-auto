import { describe, expect, it, vi } from 'vitest';
import { ProviderRegistry } from '../../src/ai/registry.js';
import { checkApiKey, cleanKey, looksLikeKey } from '../../src/onboarding/key-check.js';
import { ContentCipher } from '../../src/security/crypto.js';
import { TenantProviderRegistry } from '../../src/tenancy/ai-registry.js';
import { runAsSystem, runWithTenant } from '../../src/tenancy/context.js';
import { testEnv } from '../support/env.js';

const env = { GEMINI_BASE_URL: 'https://g.test/v1beta', OPENAI_BASE_URL: 'https://o.test/v1', ANTHROPIC_BASE_URL: 'https://a.test/v1' };
const GEMINI_KEY = `AIza${'x'.repeat(35)}`;
const OPENAI_KEY = `sk-proj-${'y'.repeat(40)}`;
const respond = (status: number, body = '') => vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

describe('API key check', () => {
  it('cleans pasted keys and checks their shape per provider', () => {
    expect(cleanKey('  "AIzaABC"  ')).toBe('AIzaABC');
    expect(cleanKey('API key: sk-123')).toBe('sk-123');
    expect(looksLikeKey('gemini', GEMINI_KEY)).toBe(true);
    expect(looksLikeKey('openai', GEMINI_KEY)).toBe(false);
    expect(looksLikeKey('anthropic', `sk-ant-${'z'.repeat(40)}`)).toBe(true);
    expect(looksLikeKey('anthropic', OPENAI_KEY)).toBe(false);
  });

  it('a key of the wrong shape is invalid without any request', async () => {
    const fetchImpl = respond(200);
    expect(await checkApiKey('openai', 'hello', env, fetchImpl)).toBe('invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps provider answers: 200 valid, 401/403 and Gemini 400 API_KEY_INVALID invalid, others unavailable', async () => {
    expect(await checkApiKey('gemini', GEMINI_KEY, env, respond(200))).toBe('valid');
    expect(await checkApiKey('openai', OPENAI_KEY, env, respond(401))).toBe('invalid');
    expect(await checkApiKey('gemini', GEMINI_KEY, env, respond(400, '{"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}'))).toBe('invalid');
    expect(await checkApiKey('gemini', GEMINI_KEY, env, respond(429))).toBe('unavailable');
    expect(await checkApiKey('gemini', GEMINI_KEY, env, respond(503))).toBe('unavailable');
    const down = vi.fn(async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    expect(await checkApiKey('gemini', GEMINI_KEY, env, down)).toBe('unavailable');
  });

  it('sends the key the way each provider expects', async () => {
    const fetchImpl = respond(200);
    await checkApiKey('openai', OPENAI_KEY, env, fetchImpl);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://o.test/v1/models');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${OPENAI_KEY}`);
  });
});

describe('TenantProviderRegistry', () => {
  const cipher = new ContentCipher(Buffer.alloc(32, 9).toString('base64'));
  const e = testEnv(); // the deployment has a Gemini key
  const shared = ProviderRegistry.fromEnv(e);
  const registry = new TenantProviderRegistry(shared, e, cipher, 100n);

  it('the super-admin workspace and system work use the deployment keys', () => {
    runWithTenant({ tenantId: 1, ownerTelegramUserId: 100n, language: 'uz' }, () => expect(registry.isConfigured('gemini')).toBe(true));
    runAsSystem(() => expect(registry.isConfigured('gemini')).toBe(true));
  });

  it('other workspaces use only their own key — never the deployment key', () => {
    runWithTenant({ tenantId: 2, ownerTelegramUserId: 200n, language: 'uz', ai: { provider: null, keyEnc: null } }, () => {
      expect(registry.configured()).toEqual([]);
    });
    const keyEnc = cipher.encrypt(OPENAI_KEY);
    runWithTenant({ tenantId: 3, ownerTelegramUserId: 300n, language: 'ru', ai: { provider: 'openai', keyEnc } }, () => {
      expect(registry.configured().map((p) => p.id)).toEqual(['openai']);
      expect(registry.isConfigured('gemini')).toBe(false);
      // Cached per key: the same provider instance for the same key.
      expect(registry.get('openai')).toBe(registry.get('openai'));
    });
  });
});
