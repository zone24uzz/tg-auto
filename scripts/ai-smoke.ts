/**
 * Manual live check of the Gemini provider (NOT part of the test suite — it calls the real API).
 *   npx tsx scripts/ai-smoke.ts
 * Reads GEMINI_API_KEY / GEMINI_BASE_URL / AI_SMOKE_MODEL from the environment or .env.
 * Prints results only; never prints keys.
 */
import { loadDotEnv } from '../src/config/dotenv.js';
import { estimateCostUsd } from '../src/ai/pricing.js';
import { GEMINI_DEFAULT_BASE_URL, GeminiProvider } from '../src/ai/providers/gemini.js';
import { describeError, registerSecrets } from '../src/logging/sanitize.js';

loadDotEnv('.env');

const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) {
  console.log('GEMINI_API_KEY is not set — skipping live smoke test.');
  process.exit(0);
}
registerSecrets([apiKey]);

const model = process.env.AI_SMOKE_MODEL?.trim() || 'gemini-3.8-flash';
const gemini = new GeminiProvider({
  apiKey,
  baseUrl: process.env.GEMINI_BASE_URL?.trim() || GEMINI_DEFAULT_BASE_URL,
  timeoutMs: 60_000,
});

let failures = 0;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    failures++;
    console.log(`✗ ${name}: ${describeError(error)}`);
  }
}

await step('listModels', async () => {
  const models = await gemini.listModels();
  console.log(`✓ listModels: ${models.length} models; first 10: ${models.slice(0, 10).map((m) => m.id).join(', ')}`);
});

await step('generateText', async () => {
  const r = await gemini.generateText({
    model,
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'Salom! Bir jumlada javob ber.' }] }],
    maxOutputTokens: 200,
    reasoningEffort: 'low',
  });
  const cost = estimateCostUsd({ provider: 'gemini', model, ...r.usage });
  console.log(
    `✓ generateText (${model}, ${r.latencyMs}ms, in=${r.usage.inputTokens} out=${r.usage.outputTokens} ` +
      `thoughts=${r.usage.reasoningTokens ?? 0}, ~$${cost.toFixed(6)}): ${r.text.trim().slice(0, 200)}`,
  );
});

await step('classify JSON (reasoning minimal → expects MINIMAL→low retry on models without minimal)', async () => {
  const r = await gemini.generateText({
    model,
    system: 'Classify the user message. Answer strictly with the requested JSON.',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'Ertaga soat nechida uchrashamiz?' }] }],
    reasoningEffort: 'minimal',
    maxOutputTokens: 200,
    json: {
      name: 'classification',
      schema: {
        type: 'object',
        properties: {
          intent: { type: 'string', enum: ['question', 'greeting', 'request', 'other'] },
          personal: { type: 'boolean' },
          confidence: { type: 'number' },
        },
        required: ['intent', 'personal', 'confidence'],
      },
    },
  });
  console.log(`✓ classify (${r.latencyMs}ms, in=${r.usage.inputTokens} out=${r.usage.outputTokens}): ${r.text}`);
});

console.log(failures === 0 ? 'Smoke test passed.' : `Smoke test finished with ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
