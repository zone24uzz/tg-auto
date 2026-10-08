/**
 * Shows which Gemini quota a 429 refers to (per-minute vs per-day, model), using GEMINI_API_KEY from .env.
 *
 *   node --import tsx scripts/gemini-quota.ts [model]
 */
import { loadDotEnv } from '../src/config/dotenv.js';

loadDotEnv();
const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error('GEMINI_API_KEY missing');
const models = process.argv[2] ? [process.argv[2]] : ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'];
for (const model of models) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ok' }] }], generationConfig: { maxOutputTokens: 5 } }),
  });
  if (res.ok) {
    console.log(`${model}: OK (${res.status})`);
    continue;
  }
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; details?: Array<Record<string, unknown>> } };
  const violations = (body.error?.details ?? [])
    .flatMap((d) => (Array.isArray(d.violations) ? (d.violations as Array<Record<string, unknown>>) : []))
    .map((v) => `${String(v.quotaId ?? v.quotaMetric ?? '?')} limit=${String(v.quotaValue ?? '?')}`);
  const retry = (body.error?.details ?? []).find((d) => typeof d.retryDelay === 'string')?.retryDelay;
  console.log(`${model}: HTTP ${res.status} ${violations.join('; ') || (body.error?.message ?? '').slice(0, 160)}${retry ? ` retryDelay=${String(retry)}` : ''}`);
}
