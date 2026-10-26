import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setHttpSleep } from '../../src/ai/http.js';
import { PricingTable } from '../../src/ai/pricing.js';
import { GeminiProvider } from '../../src/ai/providers/gemini.js';
import { ProviderRegistry } from '../../src/ai/registry.js';
import { DefaultAiRouter } from '../../src/ai/router/ai-router.js';
import { AIProviderError } from '../../src/ai/types.js';
import { FakeProvider, baseSettings, mockFetch } from './helpers.js';

const msg = [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'USD kursi bugun?' }] }];

describe('Gemini Google Search grounding', () => {
  beforeEach(() => setHttpSleep(async () => {}));
  afterEach(() => {
    setHttpSleep();
    vi.unstubAllGlobals();
  });

  it('adds the google_search tool and returns the grounded sources', async () => {
    const { calls } = mockFetch([
      {
        json: {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: '1 USD ≈ 12 000 so‘m.' }] },
              finishReason: 'STOP',
              groundingMetadata: {
                groundingChunks: [
                  { web: { uri: 'https://cbu.uz/kurs', title: 'cbu.uz' } },
                  { web: { uri: 'https://cbu.uz/kurs', title: 'dup' } },
                  { web: { uri: 'javascript:alert(1)', title: 'bad' } },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
        },
      },
    ]);
    const gemini = new GeminiProvider({ apiKey: 'test-key-123456', baseUrl: 'https://g.test/v1beta' });
    const r = await gemini.generateText({ model: 'gemini-3.5-flash', messages: msg, webSearch: true });
    expect((calls[0]!.json as { tools?: unknown[] }).tools).toEqual([{ google_search: {} }]);
    expect(r.text).toContain('12 000');
    expect(r.sources).toEqual([{ url: 'https://cbu.uz/kurs', title: 'cbu.uz' }]);
  });

  it('a model that timed out is skipped for a while (the fallback answers at once)', async () => {
    const gemini = new FakeProvider('gemini');
    gemini.generateText.mockImplementation(async (req) => {
      if (req.model === 'gemini-3.8-flash') throw new AIProviderError('gemini: request timed out after 30000ms', 'gemini', 'TIMEOUT');
      return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, provider: 'gemini', model: req.model, latencyMs: 1 };
    });
    const settings = baseSettings({ fallbackModel: 'gemini-3.5-flash' });
    const router = new DefaultAiRouter({
      registry: new ProviderRegistry([gemini]),
      settings: { get: async () => settings },
      usage: { record: vi.fn(async () => undefined) },
      timeoutMs: 1000,
      pricing: new PricingTable(),
    });
    await expect(router.generateReply({ messages: msg })).resolves.toMatchObject({ model: 'gemini-3.5-flash' });
    await expect(router.generateReply({ messages: msg })).resolves.toMatchObject({ model: 'gemini-3.5-flash' });
    expect(gemini.generateText.mock.calls.filter(([req]) => req.model === 'gemini-3.8-flash')).toHaveLength(1);
  });

  it('a refused web-search call does not cool the model down for ordinary replies', async () => {
    const gemini = new FakeProvider('gemini');
    gemini.generateText.mockImplementation(async (req) => {
      if (req.webSearch) throw new AIProviderError('gemini HTTP 429: billing', 'gemini', 'RATE_LIMIT', { status: 429, quotaExhausted: true });
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
    await expect(router.generateReply({ messages: msg, webSearch: true })).rejects.toThrow();
    await expect(router.generateReply({ messages: msg })).resolves.toMatchObject({ model: 'gemini-3.8-flash' });
    expect(gemini.generateText.mock.calls.filter(([req]) => !req.webSearch)).toHaveLength(1);
  });
});
