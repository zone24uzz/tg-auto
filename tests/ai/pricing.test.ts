import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICE, PricingTable, estimateCostUsd } from '../../src/ai/pricing.js';

const M = 1_000_000;

describe('pricing estimates', () => {
  const table = new PricingTable();

  it.each([
    ['gemini-3.8-flash', 0.3 + 2.5],
    ['gemini-3.5-flash-lite', 0.1 + 0.4],
    ['gemini-3.1-pro-preview', 2 + 12],
    ['gemini-3.8-flash-tts', 0.5 + 10],
    ['gemini-3.5-transcribe', 0.3 + 2.5],
    ['gpt-5', 1.25 + 10],
    ['gpt-5-mini', 0.25 + 2],
    ['gpt-5-nano', 0.05 + 0.4],
    ['gpt-4o-transcribe', 2.5 + 10],
    ['gpt-4o-mini-tts', 0.6 + 12],
    ['claude-sonnet-4-5', 3 + 15],
    ['claude-haiku-4-5-20251001', 1 + 5],
    ['claude-opus-4-6', 5 + 25],
  ])('%s: 1M in + 1M out ≈ $%d', (model, expected) => {
    expect(table.estimate({ provider: 'gemini', model, inputTokens: M, outputTokens: M })).toBeCloseTo(expected, 6);
  });

  it('bills whisper-1 per minute', () => {
    expect(estimateCostUsd({ provider: 'openai', model: 'whisper-1', audioSeconds: 120 }, table)).toBeCloseTo(0.012, 6);
  });

  it('uses a conservative default for unknown models', () => {
    expect(table.priceFor('mystery-model-9')).toEqual(DEFAULT_PRICE);
    expect(table.estimate({ provider: 'openai_compat', model: 'mystery', inputTokens: M, outputTokens: M })).toBe(6);
  });

  it('rounds to 6 decimals', () => {
    expect(table.estimate({ provider: 'gemini', model: 'gemini-3.8-flash', inputTokens: 1, outputTokens: 1 })).toBe(0.000003);
  });
});

describe('AI_PRICING_JSON overrides', () => {
  it('matches exact ids before the longest prefix', () => {
    const table = new PricingTable(
      JSON.stringify({ 'gemini-3': { input: 1, output: 1 }, 'gemini-3.8': { input: 2, output: 2 }, 'gemini-3.8-flash': { input: 3, output: 3 } }),
    );
    expect(table.priceFor('gemini-3.8-flash')).toEqual({ input: 3, output: 3 });
    expect(table.priceFor('gemini-3.8-pro')).toEqual({ input: 2, output: 2 });
    expect(table.priceFor('gemini-3.5-flash')).toEqual({ input: 1, output: 1 });
    expect(table.priceFor('gpt-5')).toEqual({ input: 1.25, output: 10 });
  });

  it('ignores invalid JSON and invalid entries (keeping valid ones)', () => {
    expect(new PricingTable('{not json').priceFor('gemini-3.8-flash')).toEqual({ input: 0.3, output: 2.5 });
    const table = new PricingTable(JSON.stringify({ bad: { input: -1, output: 'x' }, good: { input: 9, output: 9 } }));
    expect(table.priceFor('bad-model')).toEqual(DEFAULT_PRICE);
    expect(table.priceFor('good-model')).toEqual({ input: 9, output: 9 });
  });
});
