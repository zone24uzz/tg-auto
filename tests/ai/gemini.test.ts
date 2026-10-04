import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setHttpSleep } from '../../src/ai/http.js';
import { GeminiProvider } from '../../src/ai/providers/gemini.js';
import { AIProviderError } from '../../src/ai/types.js';
import { geminiOk, mockFetch } from './helpers.js';

const KEY = 'AIzaSyTESTKEY_1234567890abcdefghijklmno';
const BASE = 'https://generativelanguage.example/v1beta';

function provider(): GeminiProvider {
  return new GeminiProvider({ apiKey: KEY, baseUrl: BASE, timeoutMs: 5000 });
}

beforeEach(() => setHttpSleep(async () => {}));
afterEach(() => {
  setHttpSleep();
  vi.unstubAllGlobals();
});

const user = (text: string) => ({ role: 'user' as const, parts: [{ type: 'text' as const, text }] });

describe('GeminiProvider.generateText', () => {
  it('builds the REST request (key in header, never in URL) and parses non-thought text + usage', async () => {
    const { calls } = mockFetch([geminiOk('Salom!', { thought: 'internal reasoning' })]);
    const res = await provider().generateText({
      model: 'gemini-3.8-flash',
      system: 'Be brief.',
      messages: [
        user('hi'),
        { role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
        { role: 'user', parts: [{ type: 'image', image: { data: Buffer.from('img'), mimeType: 'image/png' } }, { type: 'text', text: 'what?' }] },
      ],
      reasoningEffort: 'low',
      maxOutputTokens: 100,
      temperature: 0.4,
    });

    const call = calls[0];
    expect(call?.url).toBe(`${BASE}/models/gemini-3.8-flash:generateContent`);
    expect(call?.url).not.toContain(KEY);
    expect(call?.headers['x-goog-api-key']).toBe(KEY);
    const body = call?.json ?? {};
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
      { role: 'user', parts: [{ inline_data: { mime_type: 'image/png', data: Buffer.from('img').toString('base64') } }, { text: 'what?' }] },
    ]);
    const gc = body.generationConfig as Record<string, unknown>;
    expect(gc.thinkingConfig).toEqual({ thinkingLevel: 'low' });
    expect(gc.temperature).toBe(0.4);
    expect(gc.maxOutputTokens).toBeGreaterThan(100); // thinking allowance added

    expect(res.text).toBe('Salom!');
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 12, reasoningTokens: 7 });
    expect(res.provider).toBe('gemini');
  });

  it('requests JSON with responseMimeType + responseJsonSchema', async () => {
    const schema = { type: 'object', properties: { intent: { type: 'string' } }, required: ['intent'] };
    const { calls } = mockFetch([geminiOk('{"intent":"question"}')]);
    const res = await provider().generateText({ model: 'gemini-3.5-flash', messages: [user('x')], json: { schema } });
    const gc = calls[0]?.json?.generationConfig as Record<string, unknown>;
    expect(gc.responseMimeType).toBe('application/json');
    expect(gc.responseJsonSchema).toEqual(schema);
    expect(JSON.parse(res.text)).toEqual({ intent: 'question' });
  });

  it('retries once with thinkingLevel low when MINIMAL is unsupported, then remembers it', async () => {
    const { calls } = mockFetch([
      {
        status: 400,
        json: {
          error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Thinking level MINIMAL is not supported for this model. Please use LOW.' },
        },
      },
      geminiOk('ok'),
      geminiOk('again'),
    ]);
    const p = provider();
    const res = await p.generateText({ model: 'gemini-3.8-flash', messages: [user('x')], reasoningEffort: 'minimal' });
    expect(res.text).toBe('ok');
    expect(calls).toHaveLength(2);
    expect((calls[0]?.json?.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
    expect((calls[1]?.json?.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingLevel: 'low' });

    await p.generateText({ model: 'gemini-3.8-flash', messages: [user('y')], reasoningEffort: 'minimal' });
    expect(calls).toHaveLength(3);
    expect((calls[2]?.json?.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingLevel: 'low' });
  });

  it('drops thinkingConfig after a generic thinking-related 400', async () => {
    const { calls } = mockFetch([
      { status: 400, json: { error: { message: 'thinking_budget is not supported by this model' } } },
      geminiOk('ok'),
    ]);
    await provider().generateText({ model: 'gemini-2.5-flash', messages: [user('x')], reasoningEffort: 'medium' });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.json?.generationConfig).toBeUndefined();
  });

  it('does not retry unrelated 400s', async () => {
    const { calls } = mockFetch([{ status: 400, json: { error: { message: 'Invalid value at contents' } } }]);
    await expect(provider().generateText({ model: 'gemini-3.8-flash', messages: [user('x')], reasoningEffort: 'low' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(calls).toHaveLength(1);
  });

  it('retries 503 "high demand"', async () => {
    const { calls } = mockFetch([
      { status: 503, json: { error: { message: 'The model is overloaded / experiencing high demand.' } } },
      geminiOk('done'),
    ]);
    const res = await provider().generateText({ model: 'gemini-3.8-flash', messages: [user('x')] });
    expect(res.text).toBe('done');
    expect(calls).toHaveLength(2);
  });

  it('maps SAFETY / empty responses', async () => {
    mockFetch([geminiOk('', { finishReason: 'SAFETY' })]);
    await expect(provider().generateText({ model: 'gemini-3.8-flash', messages: [user('x')] })).rejects.toMatchObject({ code: 'SAFETY' });
    mockFetch([{ json: { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } }]);
    await expect(provider().generateText({ model: 'gemini-3.8-flash', messages: [user('x')] })).rejects.toMatchObject({ code: 'SAFETY' });
    mockFetch([{ json: { candidates: [] } }]);
    await expect(provider().generateText({ model: 'gemini-3.8-flash', messages: [user('x')] })).rejects.toMatchObject({ code: 'EMPTY' });
    mockFetch([geminiOk('', { finishReason: 'MAX_TOKENS' })]);
    await expect(provider().generateText({ model: 'gemini-3.8-flash', messages: [user('x')] })).rejects.toBeInstanceOf(AIProviderError);
  });
});

describe('GeminiProvider media', () => {
  it('transcribes with inline audio and the verbatim instruction, without thinking for *-transcribe', async () => {
    const { calls } = mockFetch([geminiOk('  Salom dunyo  ')]);
    const res = await provider().transcribeAudio({ model: 'gemini-3.5-transcribe', audio: Buffer.from('OggS'), mimeType: 'audio/ogg' });
    const body = calls[0]?.json ?? {};
    const parts = (body.contents as Array<{ parts: Array<Record<string, unknown>> }>)[0]?.parts ?? [];
    expect(parts[0]?.text).toContain('Transcribe this audio verbatim in its original language. Output only the transcript.');
    expect(parts[1]).toEqual({ inline_data: { mime_type: 'audio/ogg', data: Buffer.from('OggS').toString('base64') } });
    expect(body.generationConfig).toBeUndefined();
    expect(res.text).toBe('Salom dunyo');
  });

  it('includes frame timestamps and transcript for video context', async () => {
    const { calls } = mockFetch([geminiOk('a cat')]);
    await provider().analyzeVideoContext({
      model: 'gemini-3.8-flash',
      frames: [
        { data: Buffer.from('f1'), mimeType: 'image/jpeg', timestampSec: 0 },
        { data: Buffer.from('f2'), mimeType: 'image/jpeg', timestampSec: 5 },
      ],
      transcript: 'meow',
      metadata: { kind: 'video', durationSec: 10, hasAudio: true },
      prompt: 'Describe the video.',
    });
    const text = JSON.stringify(calls[0]?.json?.contents);
    expect(text).toContain('Frame at 0.0s');
    expect(text).toContain('Frame at 5.0s');
    expect(text).toContain('meow');
    expect(text).toContain('Describe the video.');
    expect(text.match(/inline_data/g)).toHaveLength(2);
  });

  it('synthesizes speech as PCM with the sample rate parsed from the MIME type', async () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    const { calls } = mockFetch([
      {
        json: {
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 40 },
        },
      },
    ]);
    const res = await provider().synthesizeSpeech({ model: 'gemini-3.8-flash-tts', text: 'Salom', voice: 'alloy' });
    const gc = calls[0]?.json?.generationConfig as Record<string, unknown>;
    expect(gc.responseModalities).toEqual(['AUDIO']);
    expect(gc.speechConfig).toEqual({ voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } });
    expect(res.format).toBe('pcm16');
    expect(res.sampleRate).toBe(24000);
    expect(res.audio.equals(pcm)).toBe(true);
  });
});

describe('GeminiProvider.listModels / capabilities', () => {
  it('filters to chat models and strips the models/ prefix', async () => {
    const { calls } = mockFetch([
      {
        json: {
          models: [
            { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
            { name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.5-transcribe', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
            { name: 'models/gemini-3.5-flash-image', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] },
          ],
        },
      },
    ]);
    const p = provider();
    const models = await p.listModels();
    expect(models.map((m) => m.id)).toEqual(['gemini-3.8-flash', 'gemini-flash-latest']);
    expect(calls[0]?.url).toBe(`${BASE}/models?pageSize=200`);
    await p.listModels(); // cached
    expect(calls).toHaveLength(1);
  });

  it('falls back to the curated list on failure', async () => {
    mockFetch([{ status: 500, json: {} }, { status: 500, json: {} }]);
    const models = await provider().listModels();
    expect(models.map((m) => m.id)).toContain('gemini-3.8-flash');
  });

  it('reports tts only for tts models', () => {
    const p = provider();
    expect(p.capabilities('gemini-3.8-flash').tts).toBe(false);
    expect(p.capabilities('gemini-3.8-flash-tts').tts).toBe(true);
    expect(p.capabilities().tts).toBe(true);
    expect(p.capabilities('gemini-3.8-flash')).toMatchObject({ vision: true, audioTranscription: true, reasoning: true, jsonSchema: true });
    expect(new GeminiProvider({}).isConfigured()).toBe(false);
  });
});
