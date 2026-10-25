/**
 * Live check of Gemini Google Search grounding with GEMINI_API_KEY from .env (key never printed).
 *
 *   node --import tsx scripts/search-live.ts [model] "[question]"
 */
import { loadDotEnv } from '../src/config/dotenv.js';
import { GeminiProvider } from '../src/ai/providers/gemini.js';

loadDotEnv();
const model = process.argv[2] ?? 'gemini-3.5-flash';
const question = process.argv[3] ?? 'Bugun 1 AQSH dollari necha so‘m? Markaziy bank kursi.';
const gemini = new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY, baseUrl: process.env.GEMINI_BASE_URL, timeoutMs: 60_000 });
const started = Date.now();
try {
  const r = await gemini.generateText({
    model,
    system: 'Answer using Google Search for current facts. Be concise, plain text, in the language of the question.',
    messages: [{ role: 'user', parts: [{ type: 'text', text: question }] }],
    maxOutputTokens: 600,
    temperature: 0.3,
    webSearch: true,
  });
  console.log(`model=${r.model} ${Date.now() - started}ms`);
  console.log('answer:', r.text.slice(0, 400).replace(/\s+/g, ' '));
  console.log('sources:', (r.sources ?? []).map((s) => s.title ?? s.url).slice(0, 5).join(' | ') || '(none)');
} catch (error) {
  console.log('ERROR:', error instanceof Error ? error.message.slice(0, 300) : String(error));
}
