/**
 * Pure mapping of our provider-neutral ReasoningEffort to provider-specific request parameters.
 *
 * Every function returns `undefined` when the model does not support the feature, in which case
 * the caller must NOT send any reasoning parameter (sending one to an unsupported model is a 400).
 */
import type { ProviderId, ReasoningEffort } from './types.js';

function norm(model: string): string {
  return model.trim().toLowerCase().replace(/^models\//, '');
}

// ───────────────────────────── Gemini ─────────────────────────────

export type GeminiThinkingConfig = { thinkingBudget: number } | { thinkingLevel: ReasoningEffort };

const GEMINI_BUDGETS: Record<Exclude<ReasoningEffort, 'minimal'>, number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
};

/** Models that never accept thinkingConfig (TTS, transcription, embeddings, image, live/audio-native, Gemma). */
function geminiNoThinking(m: string): boolean {
  return (
    m.startsWith('gemma-') ||
    m.includes('tts') ||
    m.includes('transcribe') ||
    m.includes('embedding') ||
    m.includes('image') ||
    m.includes('native-audio') ||
    m.includes('-live')
  );
}

type GeminiThinkingStyle = 'budget' | 'level' | 'none';

export function geminiThinkingStyle(model: string): GeminiThinkingStyle {
  const m = norm(model);
  if (!m.startsWith('gemini-') || geminiNoThinking(m)) return 'none';
  // Rolling aliases (gemini-flash-latest, gemini-pro-latest, gemini-flash-lite-latest) point at 3.x+.
  if (/^gemini-(flash|pro|flash-lite)-latest$/.test(m)) return 'level';
  const ver = /^gemini-(\d+)(?:\.(\d+))?/.exec(m);
  if (!ver) return 'none';
  const major = Number(ver[1]);
  const minor = Number(ver[2] ?? 0);
  if (major >= 3) return 'level';
  // Thinking arrived with 2.5; 2.0 / 1.x models reject thinkingConfig.
  if (major === 2 && minor >= 5) return 'budget';
  return 'none';
}

export function geminiThinkingConfig(model: string, effort?: ReasoningEffort): GeminiThinkingConfig | undefined {
  if (!effort) return undefined;
  const style = geminiThinkingStyle(model);
  if (style === 'none') return undefined;
  if (style === 'level') return { thinkingLevel: effort };
  if (effort === 'minimal') {
    // Pro models cannot disable thinking; 128 is their minimum budget.
    return { thinkingBudget: norm(model).includes('pro') ? 128 : 0 };
  }
  return { thinkingBudget: GEMINI_BUDGETS[effort] };
}

export function geminiSupportsReasoning(model: string): boolean {
  return geminiThinkingStyle(model) !== 'none';
}

// ───────────────────────────── OpenAI ─────────────────────────────

/** gpt-5* (except the non-reasoning *-chat variants) and the o-series. */
export function openAiIsReasoningModel(model: string): boolean {
  const m = norm(model);
  if (/^gpt-5/.test(m)) return !/-chat\b/.test(m);
  return /^o[134](\b|-|$)/.test(m);
}

export function openAiReasoningParams(
  model: string,
  effort?: ReasoningEffort,
): { reasoning: { effort: ReasoningEffort } } | undefined {
  if (!effort || !openAiIsReasoningModel(model)) return undefined;
  // The o-series never supported "minimal" (it arrived with gpt-5).
  const e: ReasoningEffort = effort === 'minimal' && /^o\d/.test(norm(model)) ? 'low' : effort;
  return { reasoning: { effort: e } };
}

/** Reasoning models reject `temperature`. */
export function openAiSupportsTemperature(model: string): boolean {
  return !openAiIsReasoningModel(model);
}

// ──────────────────────────── Anthropic ───────────────────────────

type AnthropicReasoningStyle = 'effort' | 'budget' | 'none';

/**
 * - `effort`: output_config.effort (GA, no beta header) — Opus 4.5, the 4.6+ family, generation 5, Fable/Mythos.
 * - `budget`: thinking.budget_tokens — Claude 3.7 Sonnet, Sonnet 4/4.5, Opus 4/4.1, Haiku 4.5
 *   (effort returns an error on Sonnet 4.5 / Haiku 4.5; budget_tokens is rejected on Opus 4.7+ / gen 5).
 */
export function anthropicReasoningStyle(model: string): AnthropicReasoningStyle {
  const m = norm(model);
  if (/^claude-(fable|mythos)-/.test(m)) return 'effort';
  if (/^claude-(opus|sonnet|haiku)-([5-9]|\d{2,})(\b|-|$)/.test(m)) return 'effort';
  if (/^claude-opus-4-([5-9])(\b|-|$)/.test(m)) return 'effort';
  if (/^claude-sonnet-4-([6-9])(\b|-|$)/.test(m)) return 'effort';
  if (/^claude-3-7-sonnet/.test(m)) return 'budget';
  if (/^claude-(sonnet|opus)-4(\b|-|$)/.test(m)) return 'budget';
  if (/^claude-haiku-4-5/.test(m)) return 'budget';
  return 'none';
}

const ANTHROPIC_BUDGETS: Record<Exclude<ReasoningEffort, 'minimal'>, number> = {
  low: 1024,
  medium: 4096,
  high: 12000,
};

export interface AnthropicReasoningResult {
  /** Extra top-level body params (`output_config` or `thinking`). */
  params: Record<string, unknown>;
  /** max_tokens to send (raised so the thinking budget fits). */
  maxTokens: number;
  /** True when temperature must not be sent (extended thinking enabled). */
  disallowTemperature: boolean;
  /** Effort actually requested. */
  effort: ReasoningEffort;
}

export function anthropicReasoningParams(
  model: string,
  effort: ReasoningEffort | undefined,
  maxOutputTokens: number,
): AnthropicReasoningResult | undefined {
  if (!effort) return undefined;
  const style = anthropicReasoningStyle(model);
  if (style === 'effort') {
    const e: ReasoningEffort = effort === 'minimal' ? 'low' : effort;
    // Thinking (adaptive) counts against max_tokens on models where it is always on.
    return {
      params: { output_config: { effort: e } },
      maxTokens: maxOutputTokens + reasoningTokenAllowance(e),
      disallowTemperature: false,
      effort: e,
    };
  }
  if (style === 'budget') {
    if (effort === 'minimal') return undefined; // minimal → no extended thinking at all
    const budget = ANTHROPIC_BUDGETS[effort];
    return {
      params: { thinking: { type: 'enabled', budget_tokens: budget } },
      maxTokens: budget + maxOutputTokens,
      disallowTemperature: true,
      effort,
    };
  }
  return undefined;
}

/** Sampling params are rejected on Opus 4.7+, generation 5 and Fable/Mythos. */
export function anthropicSupportsTemperature(model: string): boolean {
  const m = norm(model);
  if (/^claude-(fable|mythos)-/.test(m)) return false;
  if (/^claude-(opus|sonnet|haiku)-([5-9]|\d{2,})(\b|-|$)/.test(m)) return false;
  if (/^claude-opus-4-([7-9])(\b|-|$)/.test(m)) return false;
  return true;
}

export function anthropicSupportsReasoning(model: string): boolean {
  return anthropicReasoningStyle(model) !== 'none';
}

// ───────────────────────── OpenAI-compatible ──────────────────────

export function openAiCompatReasoningParams(
  supported: boolean,
  effort?: ReasoningEffort,
): { reasoning_effort: ReasoningEffort } | undefined {
  if (!supported || !effort) return undefined;
  return { reasoning_effort: effort };
}

// ───────────────────────────── shared ─────────────────────────────

/**
 * Extra output-token headroom for models whose thinking tokens count against the output limit
 * (Gemini thinkingLevel, OpenAI reasoning models, Anthropic adaptive thinking). Without it a small
 * maxOutputTokens can be consumed entirely by thinking and yield an empty answer.
 */
export function reasoningTokenAllowance(effort: ReasoningEffort | undefined): number {
  switch (effort) {
    case 'minimal':
      return 512;
    case 'low':
      return 2048;
    case 'medium':
      return 6144;
    case 'high':
      return 16384;
    default:
      return 0;
  }
}

/** Whether the given provider/model accepts any reasoning parameter. */
export function supportsReasoning(
  provider: ProviderId,
  model: string,
  opts: { openAiCompatSupportsReasoning?: boolean } = {},
): boolean {
  switch (provider) {
    case 'gemini':
      return geminiSupportsReasoning(model);
    case 'openai':
      return openAiIsReasoningModel(model);
    case 'anthropic':
      return anthropicSupportsReasoning(model);
    case 'openai_compat':
      return opts.openAiCompatSupportsReasoning === true;
  }
}
