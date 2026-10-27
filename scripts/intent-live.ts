/**
 * Live check that an owner command is understood (intent JSON) with GEMINI_API_KEY from .env.
 * Nothing is sent or posted.
 *
 *   node --import tsx scripts/intent-live.ts [model] "[command]"
 */
import { loadDotEnv } from '../src/config/dotenv.js';
import { GeminiProvider } from '../src/ai/providers/gemini.js';
import type { AiRouter } from '../src/ai/router/types.js';
import { parseOwnerIntent } from '../src/assistant/intent.js';

loadDotEnv();
const model = process.argv[2] ?? 'gemini-3.5-flash-lite';
const command = process.argv[3] ?? 'Kanalga post yoz: sun’iy intellekt kichik biznesga qanday yordam beradi';
const gemini = new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY, baseUrl: process.env.GEMINI_BASE_URL, timeoutMs: 30_000 });
const router = {
  classify: async (req: Parameters<AiRouter['classify']>[0]) => ({ result: await gemini.generateText({ ...req, model }) }),
} as unknown as AiRouter;
const started = Date.now();
try {
  const intent = await parseOwnerIntent(router, command, new Date(), 'Asia/Tashkent');
  console.log(`model=${model} ${Date.now() - started}ms`, JSON.stringify({ ...intent, reply: intent.reply.slice(0, 80) }));
} catch (error) {
  console.log(`ERROR after ${Date.now() - started}ms:`, error instanceof Error ? error.message.slice(0, 300) : String(error));
}
