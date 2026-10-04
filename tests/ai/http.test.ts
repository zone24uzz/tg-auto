import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractJsonObject, requestJson, setHttpSleep } from '../../src/ai/http.js';
import { AIProviderError } from '../../src/ai/types.js';
import { mockFetch } from './helpers.js';

const sleep = vi.fn(async (_ms: number) => {});

beforeEach(() => {
  sleep.mockClear();
  setHttpSleep(sleep);
});

afterEach(() => {
  setHttpSleep();
  vi.unstubAllGlobals();
});

const opts = { provider: 'gemini' as const, url: 'https://example.test/v1/x', timeoutMs: 1000, json: { a: 1 } };

async function catchError(p: Promise<unknown>): Promise<AIProviderError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof AIProviderError) return error;
    throw error;
  }
  throw new Error('expected rejection');
}

describe('requestJson error mapping', () => {
  it('maps 401 to AUTH without retrying and keeps a sanitized excerpt', async () => {
    const { calls } = mockFetch([
      { status: 401, json: { error: { message: 'API key not valid: AIzaSyA1234567890abcdefghijklmnopqrstuv', status: 'UNAUTHENTICATED' } } },
    ]);
    const err = await catchError(requestJson(opts));
    expect(err.code).toBe('AUTH');
    expect(err.options.status).toBe(401);
    expect(err.message).toContain('API key not valid');
    expect(err.message).not.toContain('AIzaSyA1234567890');
    expect(err.message).not.toContain('example.test');
    expect(calls).toHaveLength(1);
  });

  it.each([
    [400, 'BAD_REQUEST'],
    [403, 'AUTH'],
    [404, 'BAD_REQUEST'],
    [422, 'BAD_REQUEST'],
  ])('maps %i to %s without retry', async (status, code) => {
    const { calls } = mockFetch([{ status, json: { error: { message: 'nope' } } }]);
    const err = await catchError(requestJson(opts));
    expect(err.code).toBe(code);
    expect(calls).toHaveLength(1);
  });

  it('retries 429 honouring Retry-After, then succeeds', async () => {
    const { calls } = mockFetch([
      { status: 429, json: { error: { message: 'quota' } }, headers: { 'retry-after': '2' } },
      { json: { ok: true } },
    ]);
    await expect(requestJson(opts)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('caps Retry-After at 20s', async () => {
    mockFetch([{ status: 429, headers: { 'retry-after': '120' }, json: {} }, { json: { ok: 1 } }]);
    await requestJson(opts);
    expect(sleep).toHaveBeenCalledWith(20_000);
  });

  it('retries 503 and succeeds', async () => {
    const { calls } = mockFetch([
      { status: 503, json: { error: { message: 'The model is experiencing high demand' } } },
      { json: { ok: true } },
    ]);
    await expect(requestJson(opts)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('gives up after 2 extra attempts with SERVER', async () => {
    const { calls } = mockFetch([{ status: 503, json: {} }, { status: 502, json: {} }, { status: 500, json: {} }]);
    const err = await catchError(requestJson(opts));
    expect(err.code).toBe('SERVER');
    expect(err.retryable).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('maps fetch failures to NETWORK (retried)', async () => {
    const { calls } = mockFetch([new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed')]);
    const err = await catchError(requestJson(opts));
    expect(err.code).toBe('NETWORK');
    expect(calls).toHaveLength(3);
  });

  it('maps aborts to TIMEOUT without retry', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const { calls } = mockFetch([timeout]);
    const err = await catchError(requestJson(opts));
    expect(err.code).toBe('TIMEOUT');
    expect(calls).toHaveLength(1);
  });

  it('rejects invalid JSON bodies', async () => {
    mockFetch([{ text: '<html>oops</html>' }]);
    const err = await catchError(requestJson(opts));
    expect(err.code).toBe('SERVER');
  });
});

describe('extractJsonObject', () => {
  it('handles fences, prose and braces inside strings', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonObject('Sure! {"a":{"b":"}"},"c":[1,2]} hope it helps')).toBe('{"a":{"b":"}"},"c":[1,2]}');
    expect(extractJsonObject('{broken {"ok":true}')).toBe('{"ok":true}');
    expect(extractJsonObject('no json here')).toBeUndefined();
  });
});
