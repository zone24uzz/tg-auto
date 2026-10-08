import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestRaw, setHttpSleep } from '../../src/ai/http.js';
import { PricingTable } from '../../src/ai/pricing.js';
import { ProviderRegistry } from '../../src/ai/registry.js';
import { DefaultAiRouter } from '../../src/ai/router/ai-router.js';
import { AIProviderError } from '../../src/ai/types.js';
import { FakeProvider, baseSettings, mockFetch } from './helpers.js';

const PER_DAY_429 = {
  status: 429,
  json: {
    error: {
      code: 429,
      message: 'You exceeded your current quota, please check your plan and billing details.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '41328s' },
      ],
    },
  },
};

describe('quota exhaustion (HTTP layer)', () => {
  beforeEach(() => setHttpSleep(async () => {}));
  afterEach(() => {
    setHttpSleep();
    vi.unstubAllGlobals();
  });

  it('a per-day 429 is not retried and carries the cooldown', async () => {
    const { calls } = mockFetch([PER_DAY_429, PER_DAY_429, PER_DAY_429]);
    const error = await requestRaw({ url: 'https://example.test/x', provider: 'gemini', label: 't', timeoutMs: 1000, json: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AIProviderError);
    const e = error as AIProviderError;
    expect(e.code).toBe('RATE_LIMIT');
    expect(e.options.quotaExhausted).toBe(true);
    expect(e.options.cooldownMs).toBe(41_328_000);
    expect(calls).toHaveLength(1);
  });

  it('a short per-minute 429 is still retried', async () => {
    const perMinute = { status: 429, json: { error: { message: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', details: [{ retryDelay: '2s' }] } } };
    const { calls } = mockFetch([perMinute, { status: 200, json: { ok: true } }]);
    const res = await requestRaw({ url: 'https://example.test/x', provider: 'gemini', label: 't', timeoutMs: 1000, json: {} });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });
});

describe('quota exhaustion (router)', () => {
  it('skips a model whose quota is used up and goes straight to the fallback next time', async () => {
    const gemini = new FakeProvider('gemini');
    const exhausted = new AIProviderError('gemini HTTP 429: PerDay', 'gemini', 'RATE_LIMIT', { status: 429, quotaExhausted: true, cooldownMs: 3_600_000 });
    gemini.generateText.mockImplementation(async (req) => {
      if (req.model === 'gemini-3.8-flash') throw exhausted;
      return { text: `ok:${req.model}`, usage: { inputTokens: 1, outputTokens: 1 }, provider: 'gemini', model: req.model, latencyMs: 1 };
    });
    const settings = baseSettings({ fallbackModel: 'gemini-3.5-flash' });
    const router = new DefaultAiRouter({
      registry: new ProviderRegistry([gemini]),
      settings: { get: async () => settings },
      usage: { record: vi.fn(async () => undefined) },
      timeoutMs: 1000,
      pricing: new PricingTable(),
    });
    const msg = { messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'salom' }] }] };

    const first = await router.generateReply(msg);
    expect(first.model).toBe('gemini-3.5-flash');
    expect(first.usedFallback).toBe(true);
    const second = await router.generateReply(msg);
    expect(second.model).toBe('gemini-3.5-flash');
    expect(second.usedFallback).toBe(true);
    const primaryCalls = gemini.generateText.mock.calls.filter(([req]) => req.model === 'gemini-3.8-flash');
    expect(primaryCalls).toHaveLength(1); // the exhausted model was not called again
  });

  it('tries cooling models anyway when every target is cooling down', async () => {
    const gemini = new FakeProvider('gemini');
    let calls = 0;
    gemini.generateText.mockImplementation(async (req) => {
      calls++;
      if (calls === 1) throw new AIProviderError('429', 'gemini', 'RATE_LIMIT', { status: 429, cooldownMs: 3_600_000 });
      return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, provider: 'gemini', model: req.model, latencyMs: 1 };
    });
    const settings = baseSettings();
    const router = new DefaultAiRouter({
      registry: new ProviderRegistry([gemini]),
      settings: { get: async () => settings },
      usage: { record: vi.fn(async () => undefined) },
      timeoutMs: 1000,
      pricing: new PricingTable(),
    });
    const msg = { messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'salom' }] }] };
    await expect(router.generateReply(msg)).rejects.toThrow();
    // The only target is cooling down: it is still tried (and now succeeds).
    await expect(router.generateReply(msg)).resolves.toMatchObject({ model: 'gemini-3.8-flash', usedFallback: false });
  });
});
