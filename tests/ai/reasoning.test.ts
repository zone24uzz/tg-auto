import { describe, expect, it } from 'vitest';
import {
  anthropicReasoningParams,
  anthropicSupportsTemperature,
  geminiThinkingConfig,
  openAiCompatReasoningParams,
  openAiReasoningParams,
  openAiSupportsTemperature,
  supportsReasoning,
} from '../../src/ai/reasoning.js';

describe('gemini reasoning mapping', () => {
  it('uses thinkingLevel for gemini-3+ and rolling aliases', () => {
    expect(geminiThinkingConfig('gemini-3.8-flash', 'minimal')).toEqual({ thinkingLevel: 'minimal' });
    expect(geminiThinkingConfig('gemini-3.5-flash', 'medium')).toEqual({ thinkingLevel: 'medium' });
    expect(geminiThinkingConfig('gemini-3.1-pro-preview', 'high')).toEqual({ thinkingLevel: 'high' });
    expect(geminiThinkingConfig('models/gemini-3.5-flash-lite', 'low')).toEqual({ thinkingLevel: 'low' });
    expect(geminiThinkingConfig('gemini-flash-latest', 'low')).toEqual({ thinkingLevel: 'low' });
  });

  it('uses thinkingBudget for gemini-2.5', () => {
    expect(geminiThinkingConfig('gemini-2.5-flash', 'minimal')).toEqual({ thinkingBudget: 0 });
    expect(geminiThinkingConfig('gemini-2.5-flash-lite', 'minimal')).toEqual({ thinkingBudget: 0 });
    expect(geminiThinkingConfig('gemini-2.5-pro', 'minimal')).toEqual({ thinkingBudget: 128 });
    expect(geminiThinkingConfig('gemini-2.5-flash', 'low')).toEqual({ thinkingBudget: 1024 });
    expect(geminiThinkingConfig('gemini-2.5-flash', 'medium')).toEqual({ thinkingBudget: 4096 });
    expect(geminiThinkingConfig('gemini-2.5-pro', 'high')).toEqual({ thinkingBudget: 16384 });
  });

  it('returns undefined (param absent) for unsupported models or no effort', () => {
    expect(geminiThinkingConfig('gemma-3-27b-it', 'low')).toBeUndefined();
    expect(geminiThinkingConfig('gemini-3.8-flash-tts', 'low')).toBeUndefined();
    expect(geminiThinkingConfig('gemini-3.5-transcribe', 'low')).toBeUndefined();
    expect(geminiThinkingConfig('gemini-2.0-flash', 'low')).toBeUndefined();
    expect(geminiThinkingConfig('gemini-3.8-flash', undefined)).toBeUndefined();
  });
});

describe('openai reasoning mapping', () => {
  it('sends reasoning.effort only for reasoning models', () => {
    expect(openAiReasoningParams('gpt-5-mini', 'minimal')).toEqual({ reasoning: { effort: 'minimal' } });
    expect(openAiReasoningParams('gpt-5.5', 'high')).toEqual({ reasoning: { effort: 'high' } });
    expect(openAiReasoningParams('o3', 'minimal')).toEqual({ reasoning: { effort: 'low' } });
    expect(openAiReasoningParams('o4-mini', 'medium')).toEqual({ reasoning: { effort: 'medium' } });
    expect(openAiReasoningParams('gpt-4.1-mini', 'high')).toBeUndefined();
    expect(openAiReasoningParams('gpt-5-chat-latest', 'high')).toBeUndefined();
  });

  it('omits temperature for reasoning models', () => {
    expect(openAiSupportsTemperature('gpt-5')).toBe(false);
    expect(openAiSupportsTemperature('o3-mini')).toBe(false);
    expect(openAiSupportsTemperature('gpt-4.1-mini')).toBe(true);
  });
});

describe('anthropic reasoning mapping', () => {
  it('uses output_config.effort for 4.6+/gen-5 and Opus 4.5 (minimal → low)', () => {
    expect(anthropicReasoningParams('claude-opus-5-5', 'minimal', 1024)?.params).toEqual({ output_config: { effort: 'low' } });
    expect(anthropicReasoningParams('claude-sonnet-5-5', 'high', 1024)?.params).toEqual({ output_config: { effort: 'high' } });
    expect(anthropicReasoningParams('claude-opus-4-5-20251101', 'medium', 1024)?.params).toEqual({
      output_config: { effort: 'medium' },
    });
    expect(anthropicReasoningParams('claude-sonnet-4-6', 'low', 1024)?.params).toEqual({ output_config: { effort: 'low' } });
  });

  it('uses thinking.budget_tokens for older thinking models and raises max_tokens', () => {
    const r = anthropicReasoningParams('claude-sonnet-4-5', 'medium', 1024);
    expect(r?.params).toEqual({ thinking: { type: 'enabled', budget_tokens: 4096 } });
    expect(r?.maxTokens).toBe(4096 + 1024);
    expect(r?.disallowTemperature).toBe(true);
    expect(anthropicReasoningParams('claude-3-7-sonnet-latest', 'high', 500)?.maxTokens).toBe(12000 + 500);
    expect(anthropicReasoningParams('claude-opus-4-1', 'low', 1024)?.params).toEqual({
      thinking: { type: 'enabled', budget_tokens: 1024 },
    });
    // minimal → no thinking at all
    expect(anthropicReasoningParams('claude-sonnet-4-5', 'minimal', 1024)).toBeUndefined();
  });

  it('returns undefined for models without reasoning support', () => {
    expect(anthropicReasoningParams('claude-3-5-haiku-latest', 'high', 1024)).toBeUndefined();
    expect(anthropicReasoningParams('claude-3-haiku-20240307', 'high', 1024)).toBeUndefined();
  });

  it('knows which models reject temperature', () => {
    expect(anthropicSupportsTemperature('claude-opus-5-5')).toBe(false);
    expect(anthropicSupportsTemperature('claude-opus-4-7')).toBe(false);
    expect(anthropicSupportsTemperature('claude-sonnet-4-5')).toBe(true);
  });
});

describe('openai_compat reasoning mapping', () => {
  it('only sends reasoning_effort when the endpoint supports it', () => {
    expect(openAiCompatReasoningParams(false, 'high')).toBeUndefined();
    expect(openAiCompatReasoningParams(true, 'high')).toEqual({ reasoning_effort: 'high' });
    expect(supportsReasoning('openai_compat', 'x', { openAiCompatSupportsReasoning: true })).toBe(true);
    expect(supportsReasoning('openai_compat', 'x')).toBe(false);
  });
});
