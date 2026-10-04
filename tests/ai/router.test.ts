import { describe, expect, it, vi } from 'vitest';
import { PricingTable } from '../../src/ai/pricing.js';
import { ProviderRegistry } from '../../src/ai/registry.js';
import { DefaultAiRouter } from '../../src/ai/router/ai-router.js';
import { GlobalLimiter } from '../../src/ai/router/global-limiter.js';
import { AIProviderError, AllProvidersFailedError } from '../../src/ai/types.js';
import type { Settings } from '../../src/settings/schema.js';
import type { UsageEntry } from '../../src/statistics/usage.service.js';
import { FakeProvider, baseSettings } from './helpers.js';

function setup(providers: FakeProvider[], overrides: Partial<Settings> = {}, limiter?: GlobalLimiter) {
  const registry = new ProviderRegistry(providers);
  const entries: UsageEntry[] = [];
  const usage = { record: vi.fn(async (e: UsageEntry) => void entries.push(e)) };
  const settings = baseSettings(overrides);
  const router = new DefaultAiRouter({
    registry,
    settings: { get: async () => settings },
    usage,
    limiter,
    timeoutMs: 1234,
    pricing: new PricingTable(),
  });
  return { router, entries, usage };
}

const msg = { messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'salom' }] }] };

describe('DefaultAiRouter text chain', () => {
  it('uses the primary target and reports effort + cost', async () => {
    const gemini = new FakeProvider('gemini');
    const { router, entries } = setup([gemini]);
    const r = await router.generateReply(msg, { messageId: 42 });
    expect(r.provider).toBe('gemini');
    expect(r.model).toBe('gemini-3.8-flash');
    expect(r.usedFallback).toBe(false);
    expect(r.reasoningEffort).toBe('low');
    expect(r.costUsd).toBeCloseTo((1000 * 0.3 + 500 * 2.5) / 1e6, 8);
    expect(gemini.generateText).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemini-3.8-flash', reasoningEffort: 'low', timeoutMs: 1234 }));
    expect(entries).toEqual([
      expect.objectContaining({ provider: 'gemini', operation: 'TEXT', success: true, inputTokens: 1000, outputTokens: 500, messageId: 42 }),
    ]);
  });

  it('falls back when the primary throws and records both attempts', async () => {
    const gemini = new FakeProvider('gemini');
    gemini.generateText.mockRejectedValueOnce(new AIProviderError('gemini HTTP 503: overloaded', 'gemini', 'SERVER', { status: 503 }));
    const openai = new FakeProvider('openai');
    const { router, entries } = setup([gemini, openai], { fallbackProvider: 'openai', fallbackModel: 'gpt-4.1-mini' });

    const r = await router.generateReply(msg);
    expect(r.provider).toBe('openai');
    expect(r.model).toBe('gpt-4.1-mini');
    expect(r.usedFallback).toBe(true);
    expect(r.reasoningEffort).toBeUndefined(); // gpt-4.1-mini has no reasoning param
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ provider: 'gemini', success: false });
    expect(entries[1]).toMatchObject({ provider: 'openai', success: true });
    expect(entries[1]?.costUsd).toBeGreaterThan(0);
  });

  it('skips unconfigured providers', async () => {
    const anthropic = new FakeProvider('anthropic', { configured: false });
    const gemini = new FakeProvider('gemini');
    const { router } = setup([anthropic, gemini], {
      aiProvider: 'anthropic',
      aiModel: 'claude-sonnet-5-5',
      fallbackProvider: 'gemini',
      fallbackModel: 'gemini-3.5-flash',
    });
    const r = await router.generateReply(msg);
    expect(anthropic.generateText).not.toHaveBeenCalled();
    expect(r.provider).toBe('gemini');
    expect(r.model).toBe('gemini-3.5-flash');
  });

  it('dedupes identical provider+model targets', async () => {
    const gemini = new FakeProvider('gemini');
    gemini.generateText.mockRejectedValue(new AIProviderError('boom', 'gemini', 'SERVER'));
    const { router } = setup([gemini], { fallbackProvider: 'gemini', fallbackModel: 'gemini-3.8-flash' });
    await expect(router.generateReply(msg)).rejects.toBeInstanceOf(AllProvidersFailedError);
    expect(gemini.generateText).toHaveBeenCalledTimes(1);
  });

  it('throws AllProvidersFailedError with sanitized attempts when everything fails', async () => {
    const gemini = new FakeProvider('gemini');
    gemini.generateText.mockRejectedValue(new Error('bad key AIzaSyLEAKEDKEY_0123456789abcdefghijkl'));
    const openai = new FakeProvider('openai');
    openai.generateText.mockRejectedValue(new AIProviderError('openai HTTP 401', 'openai', 'AUTH'));
    const { router, entries } = setup([gemini, openai], { fallbackProvider: 'openai', fallbackModel: 'gpt-5-mini' });

    const err = await router.generateReply(msg).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    const failed = err as AllProvidersFailedError;
    expect(failed.operation).toBe('TEXT');
    expect(failed.attempts.map((a) => `${a.provider}/${a.model}`)).toEqual(['gemini/gemini-3.8-flash', 'openai/gpt-5-mini']);
    expect(failed.attempts[0]?.error).not.toContain('AIzaSyLEAKEDKEY');
    expect(entries.every((e) => !e.success)).toBe(true);
  });

  it('throws AllProvidersFailedError when no provider is configured', async () => {
    const { router } = setup([new FakeProvider('gemini', { configured: false })]);
    await expect(router.generateReply(msg)).rejects.toMatchObject({ name: 'AllProvidersFailedError', attempts: [] });
  });

  it('skips targets whose model belongs to another provider', async () => {
    const openai = new FakeProvider('openai');
    const gemini = new FakeProvider('gemini');
    const { router } = setup([openai, gemini], {
      aiProvider: 'openai',
      aiModel: 'gemini-3.8-flash',
      fallbackProvider: 'gemini',
      fallbackModel: 'gemini-3.8-flash',
    });
    const r = await router.generateReply(msg);
    expect(openai.generateText).not.toHaveBeenCalled();
    expect(r.provider).toBe('gemini');
  });
});

describe('DefaultAiRouter global limiter', () => {
  it('blocks calls beyond the per-minute limit without calling providers', async () => {
    const gemini = new FakeProvider('gemini');
    let now = 1_000_000;
    const limiter = new GlobalLimiter(() => now);
    const { router, entries } = setup([gemini], { globalAiRequestsPerMinute: 1 }, limiter);

    await router.generateReply(msg);
    await expect(router.generateReply(msg)).rejects.toBeInstanceOf(AllProvidersFailedError);
    expect(gemini.generateText).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(1);

    now += 60_001;
    await expect(router.generateReply(msg)).resolves.toMatchObject({ provider: 'gemini' });
  });

  it('GlobalLimiter slides its window', () => {
    let now = 0;
    const l = new GlobalLimiter(() => now);
    expect(l.tryAcquire(2)).toBe(true);
    now = 30_000;
    expect(l.tryAcquire(2)).toBe(true);
    expect(l.tryAcquire(2)).toBe(false);
    now = 60_000; // first stamp (t=0) expires
    expect(l.tryAcquire(2)).toBe(true);
    expect(l.inWindow()).toBe(2);
  });
});

describe('DefaultAiRouter specialised operations', () => {
  it('classify: classifier target first, low effort, JSON required', async () => {
    const gemini = new FakeProvider('gemini');
    const { router } = setup([gemini], { classifierModel: 'gemini-3.5-flash-lite' });
    const r = await router.classify({ ...msg, json: { schema: { type: 'object' } } });
    expect(r.model).toBe('gemini-3.5-flash-lite');
    expect(gemini.generateText).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'low' }));
    await expect(router.classify(msg)).rejects.toBeInstanceOf(TypeError);
  });

  it('summarize uses low effort on the reply chain', async () => {
    const gemini = new FakeProvider('gemini');
    const { router, entries } = setup([gemini], { reasoningEffort: 'high' });
    await router.summarize(msg);
    expect(gemini.generateText).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'low', model: 'gemini-3.8-flash' }));
    expect(entries[0]?.operation).toBe('SUMMARY');
  });

  it('analyzeImage only uses vision-capable targets', async () => {
    const compat = new FakeProvider('openai_compat', { caps: { vision: false } });
    const gemini = new FakeProvider('gemini');
    const { router, entries } = setup([compat, gemini], {
      aiProvider: 'openai_compat',
      aiModel: 'llama-4',
      mediaProvider: null,
      fallbackProvider: 'gemini',
      fallbackModel: 'gemini-3.8-flash',
    });
    const r = await router.analyzeImage({ images: [{ data: Buffer.from('x'), mimeType: 'image/png' }], prompt: 'describe' });
    expect(compat.analyzeImage).not.toHaveBeenCalled();
    expect(r.provider).toBe('gemini');
    expect(r.usedFallback).toBe(false);
    expect(entries[0]).toMatchObject({ operation: 'VISION', imageCount: 1 });
  });

  it('transcribe: routes to a capable provider when the primary (anthropic) cannot transcribe', async () => {
    const anthropic = new FakeProvider('anthropic', { caps: { audioTranscription: false } });
    const gemini = new FakeProvider('gemini', { caps: { audioTranscription: true } });
    const { router, entries } = setup([anthropic, gemini], { aiProvider: 'anthropic', aiModel: 'claude-sonnet-5-5' });

    expect(await router.canTranscribe()).toBe(true);
    const r = await router.transcribe({ audio: Buffer.from('OggS'), mimeType: 'audio/ogg' });
    expect(anthropic.transcribeAudio).not.toHaveBeenCalled();
    expect(r.provider).toBe('gemini');
    expect(r.model).toBe('gemini-3.8-flash');
    expect(r.reasoningEffort).toBeUndefined();
    expect(entries[0]).toMatchObject({ operation: 'TRANSCRIBE', provider: 'gemini', success: true });
  });

  it('transcribe: explicit target first, then other capable providers', async () => {
    const gemini = new FakeProvider('gemini', { caps: { audioTranscription: true } });
    gemini.transcribeAudio.mockRejectedValueOnce(new AIProviderError('x', 'gemini', 'SERVER'));
    const openai = new FakeProvider('openai', { caps: { audioTranscription: true } });
    const { router } = setup([gemini, openai], { transcriptionProvider: 'gemini', transcriptionModel: 'gemini-3.5-flash' });
    const r = await router.transcribe({ audio: Buffer.from('a'), mimeType: 'audio/ogg' });
    expect(gemini.transcribeAudio).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemini-3.5-flash' }));
    expect(r.provider).toBe('gemini'); // gemini default model is tried before openai
    expect(r.model).toBe('gemini-3.8-flash');
    expect(r.usedFallback).toBe(true);
  });

  it('canTranscribe is false when nothing configured can transcribe', async () => {
    const { router } = setup([new FakeProvider('anthropic', { caps: { audioTranscription: false } })], {
      aiProvider: 'anthropic',
      aiModel: 'claude-sonnet-5-5',
    });
    expect(await router.canTranscribe()).toBe(false);
    await expect(router.transcribe({ audio: Buffer.from('a'), mimeType: 'audio/ogg' })).rejects.toBeInstanceOf(AllProvidersFailedError);
  });

  it('synthesizeSpeech: falls back to the first configured TTS provider with its default model and the settings voice', async () => {
    const anthropic = new FakeProvider('anthropic');
    const openai = new FakeProvider('openai', { caps: { tts: true }, tts: true });
    const { router } = setup([anthropic, openai], { aiProvider: 'anthropic', aiModel: 'claude-sonnet-5-5', ttsVoice: 'coral' });
    expect(await router.canSynthesizeSpeech()).toBe(true);
    const r = await router.synthesizeSpeech({ text: 'Salom' });
    expect(r.provider).toBe('openai');
    expect(r.model).toBe('gpt-4o-mini-tts');
    expect(openai.speech).toHaveBeenCalledWith(expect.objectContaining({ voice: 'coral', model: 'gpt-4o-mini-tts' }));
  });

  it('synthesizeSpeech: honours the configured TTS target', async () => {
    const gemini = new FakeProvider('gemini', { caps: { tts: true }, tts: true });
    const { router } = setup([gemini], { ttsProvider: 'gemini', ttsModel: 'gemini-3.8-flash-tts' });
    const r = await router.synthesizeSpeech({ text: 'Salom', voice: 'Puck' });
    expect(r.model).toBe('gemini-3.8-flash-tts');
    expect(gemini.speech).toHaveBeenCalledWith(expect.objectContaining({ voice: 'Puck' }));
  });

  it('canSynthesizeSpeech is false without TTS providers', async () => {
    const { router } = setup([new FakeProvider('gemini')]);
    expect(await router.canSynthesizeSpeech()).toBe(false);
  });
});
