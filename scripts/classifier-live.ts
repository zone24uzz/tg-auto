/**
 * Live check of the message classifier against the real AI provider (GEMINI_API_KEY from .env).
 * Prints category / confidence / route for a set of typical contact messages; costs a few cheap calls.
 *
 *   node --import tsx scripts/classifier-live.ts
 */
import { loadDotEnv } from '../src/config/dotenv.js';
import { GeminiProvider } from '../src/ai/providers/gemini.js';
import type { AiRouter } from '../src/ai/router/types.js';
import { MessageClassifier } from '../src/classifiers/classifier.js';
import { loadEnv } from '../src/config/env.js';
import { registerSecrets } from '../src/logging/sanitize.js';
import { buildDefaultSettings } from '../src/settings/schema.js';

loadDotEnv();
const env = loadEnv();
registerSecrets([env.GEMINI_API_KEY]);
const gemini = new GeminiProvider({ apiKey: env.GEMINI_API_KEY, baseUrl: env.GEMINI_BASE_URL, timeoutMs: 60_000 });
const settings = buildDefaultSettings(env);

const ai = {
  classify: async (req: Parameters<AiRouter['classify']>[0]) => {
    const result = await gemini.generateText({ ...req, model: settings.classifierModel ?? settings.aiModel, reasoningEffort: 'minimal' });
    return { result, provider: 'gemini', model: result.model, usedFallback: false, costUsd: 0, reasoningEffort: 'minimal' };
  },
} as unknown as AiRouter;

const cases: Array<[string, 'AUTO' | 'OWNER']> = [
  ['Mana API kalitlar: AIzaSyD-example-key-123, sk-proj-example-456', 'AUTO'],
  ['Salom, qalaysan? Ishlar yaxshimi?', 'AUTO'],
  ['Rahmat, oldim', 'AUTO'],
  ['Mana kod, ko‘rib chiq: function a() { return 1 }', 'AUTO'],
  ['Bu linkni ochib ko‘r https://github.com/zone24uzz/tg-auto', 'AUTO'],
  ['Saytingiz qancha turadi?', 'AUTO'],
  ['React yaxshimi yoki Vue?', 'AUTO'],
  ['Turmush tarzi haqida maqola yozib bera olasizmi?', 'AUTO'],
  ['Hozir qayerdasan?', 'OWNER'],
  ['Kim bilan yuribsan?', 'OWNER'],
  ['Menga 500 ming qarz berib tura olasanmi?', 'OWNER'],
  ['Ertaga uchrashamizmi?', 'OWNER'],
  ['Shu loyihaga rozimisan, 2 mln ga qilib berasanmi?', 'OWNER'],
];

const classifier = new MessageClassifier(ai);
let ok = 0;
for (const [text, expected] of cases) {
  const r = await classifier.classify({ text, history: [] }, settings);
  const pass = r.route === expected;
  if (pass) ok++;
  console.log(`${pass ? '✓' : '✗'} ${r.route.padEnd(5)} ${r.category.padEnd(14)} ${r.confidence.toFixed(2)}  ${text.slice(0, 60)}`);
}
console.log(`${ok}/${cases.length} as expected`);
