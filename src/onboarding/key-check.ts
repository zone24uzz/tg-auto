import { registerSecrets } from '../logging/sanitize.js';
import type { AiChoice } from './texts.js';

export type KeyCheck = 'valid' | 'invalid' | 'unavailable';

export interface KeyCheckEnv {
  GEMINI_BASE_URL: string;
  OPENAI_BASE_URL: string;
  ANTHROPIC_BASE_URL: string;
}

const TIMEOUT_MS = 15_000;
/** Rough shape of each provider's keys: catches pasting a key for the wrong AI before any request. */
const SHAPE: Record<AiChoice, RegExp> = {
  gemini: /^AIza[0-9A-Za-z_-]{20,80}$/,
  openai: /^sk-[A-Za-z0-9_-]{20,300}$/,
  anthropic: /^sk-ant-[A-Za-z0-9_-]{20,300}$/,
};

/** Trims what users typically paste around a key (quotes, spaces, "key:" prefixes). */
export function cleanKey(raw: string): string {
  return raw
    .trim()
    .replace(/^(api[\s_-]?key|key|kalit|ключ)\s*[:=]\s*/i, '')
    .replace(/^["'`«]+|["'`»]+$/g, '')
    .trim();
}

export function looksLikeKey(ai: AiChoice, key: string): boolean {
  return SHAPE[ai].test(key);
}

/**
 * Checks an API key with the cheapest authenticated call (list models). 401/403/400-invalid-key →
 * 'invalid'; network errors, timeouts, 429 and 5xx → 'unavailable' (the key may well be fine).
 */
export async function checkApiKey(ai: AiChoice, key: string, env: KeyCheckEnv, fetchImpl: typeof fetch = fetch): Promise<KeyCheck> {
  if (!looksLikeKey(ai, key)) return 'invalid';
  registerSecrets([key]);
  const req: { url: string; headers: Record<string, string> } =
    ai === 'gemini'
      ? { url: `${env.GEMINI_BASE_URL.replace(/\/+$/, '')}/models?pageSize=1`, headers: { 'x-goog-api-key': key } }
      : ai === 'openai'
        ? { url: `${env.OPENAI_BASE_URL.replace(/\/+$/, '')}/models`, headers: { authorization: `Bearer ${key}` } }
        : {
            url: `${env.ANTHROPIC_BASE_URL.replace(/\/+$/, '')}/models?limit=1`,
            headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          };
  let res: Response;
  try {
    res = await fetchImpl(req.url, { method: 'GET', headers: req.headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return 'unavailable';
  }
  if (res.ok) return 'valid';
  if (res.status === 401 || res.status === 403) return 'invalid';
  if (res.status === 400) {
    // Gemini answers 400 API_KEY_INVALID for a wrong key; other 400s are not about the key.
    const body = await res.text().catch(() => '');
    return /API_KEY_INVALID|API key not valid|invalid.{0,20}key/i.test(body) ? 'invalid' : 'unavailable';
  }
  return 'unavailable';
}
