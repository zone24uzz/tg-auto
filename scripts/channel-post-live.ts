/**
 * Live check of channel post writing with GEMINI_API_KEY from .env (key never printed; nothing is posted).
 * Uses the same instructions as src/channels/channel.service.ts and the same 45 s per-attempt timeout.
 *
 *   node --import tsx scripts/channel-post-live.ts [model] "[instructions]"
 */
import { loadDotEnv } from '../src/config/dotenv.js';
import { GeminiProvider } from '../src/ai/providers/gemini.js';

loadDotEnv();
const model = process.argv[2] ?? 'gemini-3.5-flash';
const instructions = process.argv[3] ?? 'Sun’iy intellekt kichik biznesga qanday yordam berishi haqida qisqa post yoz';
const gemini = new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY, baseUrl: process.env.GEMINI_BASE_URL, timeoutMs: 45_000 });
const started = Date.now();
try {
  const r = await gemini.generateText({
    model,
    system: [
      'You write posts for the Telegram channel "Test" on behalf of its owner.',
      'Follow the owner’s instructions exactly. Write an engaging, well-structured post: a strong first line, short paragraphs, a few relevant emojis, an optional call to action.',
      'Plain text only (no markdown symbols like *, _, #). About 400–1200 characters unless the owner asks otherwise. Write in the language of the instructions.',
      'Use only facts you are sure about; never invent events, numbers or dates.',
      'Return only the post text.',
    ].join('\n'),
    messages: [{ role: 'user', parts: [{ type: 'text', text: instructions }] }],
    maxOutputTokens: 1200,
    temperature: 0.8,
  });
  console.log(`model=${r.model} ${Date.now() - started}ms, ${r.text.length} chars`);
  console.log(r.text.slice(0, 700));
} catch (error) {
  console.log(`ERROR after ${Date.now() - started}ms:`, error instanceof Error ? error.message.slice(0, 300) : String(error));
}
