import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setHttpSleep } from '../../src/ai/http.js';
import { AnthropicProvider } from '../../src/ai/providers/anthropic.js';
import { OpenAICompatibleProvider } from '../../src/ai/providers/openai-compatible.js';
import { OpenAIProvider, toStrictJsonSchema } from '../../src/ai/providers/openai.js';
import { mockFetch } from './helpers.js';

beforeEach(() => setHttpSleep(async () => {}));
afterEach(() => {
  setHttpSleep();
  vi.unstubAllGlobals();
});

const user = (text: string) => ({ role: 'user' as const, parts: [{ type: 'text' as const, text }] });
const schema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['a', 'b'] },
    details: { type: 'object', properties: { score: { type: 'number' } } },
  },
  required: ['intent'],
};

function responsesOk(text: string): { json: unknown } {
  return {
    json: {
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
      ],
      usage: { input_tokens: 20, output_tokens: 30, output_tokens_details: { reasoning_tokens: 12 } },
    },
  };
}

describe('OpenAIProvider', () => {
  const openai = () => new OpenAIProvider({ apiKey: 'sk-test-abcdefghijklmnopqrstuvwxyz', baseUrl: 'https://api.openai.example/v1' });

  it('builds a Responses API request with strict json_schema and no temperature for reasoning models', async () => {
    const { calls } = mockFetch([responsesOk('{"intent":"a","details":{"score":1}}')]);
    const res = await openai().generateText({
      model: 'gpt-5-mini',
      system: 'Classify.',
      messages: [
        user('hi'),
        { role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
        { role: 'user', parts: [{ type: 'image', image: { data: Buffer.from('i'), mimeType: 'image/jpeg' } }] },
      ],
      temperature: 0.7,
      reasoningEffort: 'minimal',
      json: { schema, name: 'my classification' },
      maxOutputTokens: 100,
    });
    const call = calls[0];
    expect(call?.url).toBe('https://api.openai.example/v1/responses');
    expect(call?.headers.authorization).toBe('Bearer sk-test-abcdefghijklmnopqrstuvwxyz');
    const body = call?.json ?? {};
    expect(body.instructions).toBe('Classify.');
    expect(body.store).toBe(false);
    expect(body.temperature).toBeUndefined();
    expect(body.reasoning).toEqual({ effort: 'minimal' });
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
      { role: 'user', content: [{ type: 'input_image', image_url: `data:image/jpeg;base64,${Buffer.from('i').toString('base64')}` }] },
    ]);
    expect(body.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'my_classification',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            intent: { type: 'string', enum: ['a', 'b'] },
            details: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'], additionalProperties: false },
          },
          required: ['intent', 'details'],
          additionalProperties: false,
        },
      },
    });
    expect(JSON.parse(res.text)).toEqual({ intent: 'a', details: { score: 1 } });
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 30, reasoningTokens: 12 });
  });

  it('sends temperature but no reasoning for non-reasoning models', async () => {
    const { calls } = mockFetch([responsesOk('hey')]);
    await openai().generateText({ model: 'gpt-4.1-mini', messages: [user('x')], temperature: 0.3, reasoningEffort: 'high' });
    expect(calls[0]?.json?.temperature).toBe(0.3);
    expect(calls[0]?.json?.reasoning).toBeUndefined();
  });

  it('retries with low effort when minimal is rejected', async () => {
    const { calls } = mockFetch([
      {
        status: 400,
        json: {
          error: {
            message: "Unsupported value: 'minimal' is not supported with the 'gpt-5.5' model.",
            type: 'invalid_request_error',
            param: 'reasoning.effort',
          },
        },
      },
      responsesOk('ok'),
    ]);
    const res = await openai().generateText({ model: 'gpt-5.5', messages: [user('x')], reasoningEffort: 'minimal' });
    expect(res.text).toBe('ok');
    expect(calls[1]?.json?.reasoning).toEqual({ effort: 'low' });
  });

  it('retries without temperature when rejected', async () => {
    const { calls } = mockFetch([
      { status: 400, json: { error: { message: "Unsupported parameter: 'temperature' is not supported with this model." } } },
      responsesOk('ok'),
    ]);
    await openai().generateText({ model: 'gpt-4.1-mini', messages: [user('x')], temperature: 0.2 });
    expect(calls[1]?.json?.temperature).toBeUndefined();
  });

  it('maps refusals to SAFETY', async () => {
    mockFetch([{ json: { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] } }]);
    await expect(openai().generateText({ model: 'gpt-5', messages: [user('x')] })).rejects.toMatchObject({ code: 'SAFETY' });
  });

  it('transcribes via multipart with a generated file name', async () => {
    const { calls } = mockFetch([{ json: { text: ' salom ', usage: { type: 'tokens', input_tokens: 10, output_tokens: 3 } } }]);
    const res = await openai().transcribeAudio({ model: 'gpt-4o-transcribe', audio: Buffer.from('OggS'), mimeType: 'audio/ogg', languageHint: 'uz' });
    const form = calls[0]?.formData;
    expect(calls[0]?.url).toBe('https://api.openai.example/v1/audio/transcriptions');
    expect(form?.get('model')).toBe('gpt-4o-transcribe');
    expect(form?.get('language')).toBe('uz');
    const file = form?.get('file');
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe('audio.ogg');
    expect(res.text).toBe('salom');
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
  });

  it('synthesizes opus speech', async () => {
    const { calls } = mockFetch([{ binary: new Uint8Array([79, 103, 103, 83]) }]);
    const res = await openai().synthesizeSpeech({ model: 'gpt-4o-mini-tts', text: 'Salom', voice: 'Kore' });
    expect(calls[0]?.json).toEqual({ model: 'gpt-4o-mini-tts', input: 'Salom', voice: 'alloy', response_format: 'opus' });
    expect(res.format).toBe('ogg_opus');
    expect(res.audio.toString()).toBe('OggS');
  });

  it('filters listModels to chat models', async () => {
    mockFetch([
      {
        json: {
          data: [
            { id: 'gpt-5.5', created: 3 },
            { id: 'gpt-4o-mini-tts', created: 2 },
            { id: 'text-embedding-3-large', created: 1 },
            { id: 'o4-mini', created: 1 },
            { id: 'gpt-realtime', created: 4 },
          ],
        },
      },
    ]);
    expect((await openai().listModels()).map((m) => m.id)).toEqual(['gpt-5.5', 'o4-mini']);
  });

  it('toStrictJsonSchema handles arrays of objects', () => {
    expect(toStrictJsonSchema({ type: 'array', items: { type: 'object', properties: { a: { type: 'string' } } } })).toEqual({
      type: 'array',
      items: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
    });
  });
});

describe('AnthropicProvider', () => {
  const anthropic = () => new AnthropicProvider({ apiKey: 'sk-ant-test-abcdefghijklmnop', baseUrl: 'https://api.anthropic.example/v1' });
  const ok = (text: string) => ({
    json: {
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 11, output_tokens: 22 },
    },
  });

  it('emulates JSON via the system prompt and extracts the object', async () => {
    const { calls } = mockFetch([ok('Here you go:\n```json\n{"intent":"b"}\n```')]);
    const res = await anthropic().generateText({ model: 'claude-haiku-4-5', system: 'Classify.', messages: [user('x')], json: { schema } });
    const call = calls[0];
    expect(call?.url).toBe('https://api.anthropic.example/v1/messages');
    expect(call?.headers['x-api-key']).toBe('sk-ant-test-abcdefghijklmnop');
    expect(call?.headers['anthropic-version']).toBe('2023-06-01');
    expect(call?.json?.system).toContain('Classify.');
    expect(call?.json?.system).toContain('Respond with only a JSON object matching this JSON Schema');
    expect(call?.json?.system).toContain('"intent"');
    expect(call?.json?.max_tokens).toBe(1024);
    expect(call?.json?.output_format).toBeUndefined();
    expect(res.text).toBe('{"intent":"b"}');
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
  });

  it('throws EMPTY when JSON cannot be parsed', async () => {
    mockFetch([ok('I cannot comply with JSON today')]);
    await expect(anthropic().generateText({ model: 'claude-haiku-4-5', messages: [user('x')], json: { schema } })).rejects.toMatchObject({
      code: 'EMPTY',
    });
  });

  it('uses thinking budget (no temperature) for Sonnet 4.5', async () => {
    const { calls } = mockFetch([ok('hi')]);
    await anthropic().generateText({
      model: 'claude-sonnet-4-5',
      messages: [user('x')],
      reasoningEffort: 'medium',
      temperature: 0.5,
      maxOutputTokens: 500,
    });
    const body = calls[0]?.json ?? {};
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
    expect(body.max_tokens).toBe(4596);
    expect(body.temperature).toBeUndefined();
  });

  it('uses output_config.effort for gen-5 models and never sends temperature there', async () => {
    const { calls } = mockFetch([ok('hi')]);
    await anthropic().generateText({ model: 'claude-opus-5-5', messages: [user('x')], reasoningEffort: 'minimal', temperature: 0.5 });
    expect(calls[0]?.json?.output_config).toEqual({ effort: 'low' });
    expect(calls[0]?.json?.thinking).toBeUndefined();
    expect(calls[0]?.json?.temperature).toBeUndefined();
  });

  it('retries once without reasoning params on a related 400', async () => {
    const { calls } = mockFetch([
      { status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'output_config.effort: not supported for this model' } } },
      ok('fine'),
    ]);
    const res = await anthropic().generateText({ model: 'claude-sonnet-4-6', messages: [user('x')], reasoningEffort: 'high' });
    expect(res.text).toBe('fine');
    expect(calls[1]?.json?.output_config).toBeUndefined();
  });

  it('does not support audio', async () => {
    const p = anthropic();
    expect(p.capabilities().audioTranscription).toBe(false);
    expect(p.capabilities().tts).toBe(false);
    await expect(p.transcribeAudio({ model: 'x', audio: Buffer.from(''), mimeType: 'audio/ogg' })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });
});

describe('OpenAICompatibleProvider', () => {
  const compat = (flags: { vision?: boolean; transcription?: boolean; reasoning?: boolean } = {}) =>
    new OpenAICompatibleProvider({
      baseUrl: 'http://localhost:11434/v1/',
      models: 'llama-4, qwen3',
      supportsVision: flags.vision,
      supportsTranscription: flags.transcription,
      supportsReasoning: flags.reasoning,
    });

  it('uses json_object + schema in system prompt, drops images without vision, strips <think>', async () => {
    const { calls } = mockFetch([
      {
        json: {
          choices: [{ message: { content: '<think>let me think</think>{"intent":"a"}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 6 },
        },
      },
    ]);
    const res = await compat().generateText({
      model: 'qwen3',
      system: 'Sys',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'look' }, { type: 'image', image: { data: Buffer.from('i'), mimeType: 'image/png' } }] }],
      json: { schema },
      reasoningEffort: 'high',
    });
    const body = calls[0]?.json ?? {};
    expect(calls[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.reasoning_effort).toBeUndefined();
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]?.role).toBe('system');
    expect(String(messages[0]?.content)).toContain('JSON Schema');
    expect(messages[1]).toEqual({ role: 'user', content: 'look\n[image omitted]' });
    expect(res.text).toBe('{"intent":"a"}');
  });

  it('sends image_url parts and reasoning_effort when enabled', async () => {
    const { calls } = mockFetch([{ json: { choices: [{ message: { content: 'ok' } }] } }]);
    await compat({ vision: true, reasoning: true }).analyzeImage({
      model: 'llama-4',
      images: [{ data: Buffer.from('i'), mimeType: 'image/png' }],
      prompt: 'what',
      reasoningEffort: 'low',
    });
    const body = calls[0]?.json ?? {};
    expect(body.reasoning_effort).toBe('low');
    expect(JSON.stringify(body.messages)).toContain('"image_url":{"url":"data:image/png;base64,');
  });

  it('lists env models and gates transcription', async () => {
    const p = compat();
    expect((await p.listModels()).map((m) => m.id)).toEqual(['llama-4', 'qwen3']);
    expect(p.capabilities().audioTranscription).toBe(false);
    await expect(p.transcribeAudio({ model: 'whisper-1', audio: Buffer.from(''), mimeType: 'audio/ogg' })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    expect(new OpenAICompatibleProvider({}).isConfigured()).toBe(false);
    expect(p.isConfigured()).toBe(true);
  });
});
