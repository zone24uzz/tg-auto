/**
 * Diagnoses the onboarding API-key check against the real provider with the key from .env
 * (never printed: only its length and shape verdict).
 *
 *   node --import tsx scripts/check-key-live.ts [gemini|openai|anthropic]
 */
import { loadDotEnv } from '../src/config/dotenv.js';
import { checkApiKey, cleanKey, looksLikeKey } from '../src/onboarding/key-check.js';
import type { AiChoice } from '../src/onboarding/texts.js';

loadDotEnv();
const ai = (process.argv[2] ?? 'gemini') as AiChoice;
const raw = { gemini: process.env.GEMINI_API_KEY, openai: process.env.OPENAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY }[ai];
if (!raw) throw new Error(`no ${ai} key in .env`);
const key = cleanKey(raw);
const env = {
  GEMINI_BASE_URL: process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta',
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1',
};
console.log(`${ai}: length=${key.length} prefix=${key.slice(0, 4)} shapeOk=${looksLikeKey(ai, key)}`);
let status = 0;
let body = '';
const verdict = await checkApiKey(ai, key, env, async (url, init) => {
  const res = await fetch(url, init);
  status = res.status;
  body = (await res.clone().text()).slice(0, 300).replace(/\s+/g, ' ');
  return res;
});
console.log(`verdict=${verdict} http=${status} body=${status === 200 ? '(ok)' : body}`);
