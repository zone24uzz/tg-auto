/**
 * Approximate AI pricing used for usage statistics and the daily cost guard.
 *
 * IMPORTANT: these are ESTIMATES (USD per 1M tokens, list prices at the time of writing, no
 * caching/batch discounts, no long-context surcharges). Providers change prices and bill some
 * modalities (audio, images, thinking) differently. Override per model with AI_PRICING_JSON:
 *   AI_PRICING_JSON='{"gemini-3.8-flash":{"input":0.3,"output":2.5},"whisper-1":{"input":0,"output":0,"perMinute":0.006}}'
 * Keys match an exact model id first, then the longest key that is a prefix of the model id.
 */
import { z } from 'zod';
import { childLogger } from '../logging/logger.js';
import type { ProviderId } from './types.js';

const log = childLogger('ai-pricing');

export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens (thinking/reasoning tokens are billed as output). */
  output: number;
  /** USD per audio minute (minute-billed transcription such as whisper-1). */
  perMinute?: number;
}

/** Conservative default for unknown models. */
export const DEFAULT_PRICE: ModelPrice = { input: 1, output: 5 };

/** Ordered: the first matching pattern wins, so specific patterns come before generic ones. */
const BUILTIN: Array<{ test: RegExp; price: ModelPrice }> = [
  // ── Gemini ──
  { test: /^gemini-.*tts/, price: { input: 0.5, output: 10 } },
  { test: /^gemini-.*transcribe/, price: { input: 0.3, output: 2.5 } },
  { test: /^gemini-.*flash-lite/, price: { input: 0.1, output: 0.4 } },
  { test: /^gemini-.*pro/, price: { input: 2, output: 12 } },
  { test: /^gemini-.*flash/, price: { input: 0.3, output: 2.5 } },
  { test: /^gemma-/, price: { input: 0, output: 0 } },
  // ── OpenAI ──
  { test: /^whisper-1/, price: { input: 0, output: 0, perMinute: 0.006 } },
  { test: /^gpt-4o-mini-tts/, price: { input: 0.6, output: 12 } },
  { test: /^gpt-4o-mini-transcribe/, price: { input: 1.25, output: 5 } },
  { test: /^gpt-4o-transcribe/, price: { input: 2.5, output: 10 } },
  { test: /^gpt-5(\.\d+)?-nano/, price: { input: 0.05, output: 0.4 } },
  { test: /^gpt-5(\.\d+)?-mini/, price: { input: 0.25, output: 2 } },
  { test: /^gpt-5/, price: { input: 1.25, output: 10 } },
  { test: /^gpt-4\.1-nano/, price: { input: 0.1, output: 0.4 } },
  { test: /^gpt-4\.1-mini/, price: { input: 0.4, output: 1.6 } },
  { test: /^gpt-4\.1/, price: { input: 2, output: 8 } },
  { test: /^gpt-4o-mini/, price: { input: 0.15, output: 0.6 } },
  { test: /^(gpt-4o|chatgpt-4o)/, price: { input: 2.5, output: 10 } },
  { test: /^o4-mini/, price: { input: 1.1, output: 4.4 } },
  { test: /^o3-mini/, price: { input: 1.1, output: 4.4 } },
  { test: /^o3/, price: { input: 2, output: 8 } },
  // ── Anthropic ──
  { test: /^claude-(fable|mythos)-/, price: { input: 10, output: 50 } },
  { test: /^claude-opus-5-5/, price: { input: 4, output: 20 } },
  { test: /^claude-opus-4(-0|-1|-2025)/, price: { input: 15, output: 75 } },
  { test: /^claude-opus-/, price: { input: 5, output: 25 } },
  { test: /^claude-sonnet-5/, price: { input: 2, output: 10 } },
  { test: /^claude-(sonnet|3-7-sonnet|3-5-sonnet)/, price: { input: 3, output: 15 } },
  { test: /^claude-(haiku|3-5-haiku)/, price: { input: 1, output: 5 } },
];

const overrideEntrySchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  perMinute: z.number().nonnegative().optional(),
});

export interface CostInput {
  provider: ProviderId;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  audioSeconds?: number;
}

export class PricingTable {
  private overrides = new Map<string, ModelPrice>();

  constructor(overridesJson?: string) {
    this.setOverrides(overridesJson);
  }

  /** Replaces overrides from an AI_PRICING_JSON string. Invalid input/entries are ignored with a warning. */
  setOverrides(json: string | undefined): void {
    this.overrides = new Map();
    if (!json || !json.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      log.warn('AI_PRICING_JSON is not valid JSON; using built-in price estimates');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log.warn('AI_PRICING_JSON must be an object of {"model-or-prefix": {"input": n, "output": n}}; ignored');
      return;
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = overrideEntrySchema.safeParse(value);
      if (!key.trim() || !entry.success) {
        log.warn({ key }, 'ignoring invalid AI_PRICING_JSON entry');
        continue;
      }
      this.overrides.set(key.trim().toLowerCase(), entry.data);
    }
  }

  priceFor(model: string): ModelPrice {
    const m = model.trim().toLowerCase().replace(/^models\//, '');
    const exact = this.overrides.get(m);
    if (exact) return exact;
    let best: { key: string; price: ModelPrice } | undefined;
    for (const [key, price] of this.overrides) {
      if (m.startsWith(key) && (!best || key.length > best.key.length)) best = { key, price };
    }
    if (best) return best.price;
    return BUILTIN.find((b) => b.test.test(m))?.price ?? DEFAULT_PRICE;
  }

  /** Estimated USD cost, rounded to 6 decimals. */
  estimate(input: CostInput): number {
    const price = this.priceFor(input.model);
    let cost = 0;
    if (price.perMinute !== undefined && input.audioSeconds !== undefined && input.audioSeconds > 0) {
      cost += (input.audioSeconds / 60) * price.perMinute;
    }
    cost += ((input.inputTokens ?? 0) * price.input + (input.outputTokens ?? 0) * price.output) / 1_000_000;
    return Math.round(cost * 1e6) / 1e6;
  }
}

/** Process-wide table (configured from env by the registry). */
export const defaultPricing = new PricingTable();

export function configurePricing(overridesJson: string | undefined): void {
  defaultPricing.setOverrides(overridesJson);
}

/** Estimated USD cost of one call (see module docs: estimates only). */
export function estimateCostUsd(input: CostInput, table: PricingTable = defaultPricing): number {
  return table.estimate(input);
}
