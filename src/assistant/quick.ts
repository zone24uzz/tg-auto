import { normalizeForMatching } from '../classifiers/heuristics.js';
import type { OwnerIntent } from './intent.js';

/**
 * Owner commands understood without an AI call: timers ("10 minutga timer qo'y", "2 soatdan keyin
 * eslat: choy") and bare greetings. They work even when the AI quota is used up, cost nothing and
 * answer instantly. Anything else goes to the AI intent parser.
 */

const UNIT_MS: Array<[RegExp, number]> = [
  [/^(sek|sekund|soniya|секунд|sec|second)/u, 1_000],
  [/^(daq|daqiqa|min|minut|мин|минут|minute)/u, 60_000],
  [/^(soat|час|hour|hr)/u, 3_600_000],
];

/** "10 minut", "2 soat", "1,5 soat", "30 daq" inside the text → milliseconds. */
function durationMs(text: string): { ms: number; match: string } | null {
  const re = /(\d+(?:[.,]\d+)?)\s*([\p{L}]+)/gu;
  for (const m of text.matchAll(re)) {
    const value = Number(m[1]!.replace(',', '.'));
    const unit = UNIT_MS.find(([u]) => u.test(m[2]!));
    if (unit && value > 0) return { ms: Math.round(value * unit[1]), match: m[0] };
  }
  return null;
}

const TIMER_WORDS = /(timer|taymer|таймер|budilnik|будильник|eslat|eslatib|напомни|remind)/u;
const AFTER_WORDS = /(dan keyin|dan so'ng|keyin|ga|через|in )/u;
const GREETING =
  /^(salom|assalomu alaykum|assalom|hayrli (tong|kun|kech)|xayrli (tong|kun|kech)|привет|здравствуйте|hi|hello|hey|good (morning|evening))[\s!.,?)]*$/u;

const MAX_TIMER_MS = 7 * 86_400_000;

export function parseQuickCommand(raw: string, now: Date): OwnerIntent | null {
  const text = normalizeForMatching(raw);
  if (!text) return null;
  if (GREETING.test(text))
    return { action: 'chat', repeat: false, needsSearch: false, exact: false, reply: 'Salom! 👋 Nima yordam kerak? Masalan: «10 minutdan keyin eslat», «bugungi xulosa», «kanalga post yoz: …».' };

  // Timer / relative reminder: needs a reminder word AND a duration ("10 minutga timer qo'y").
  if (!TIMER_WORDS.test(text)) return null;
  const d = durationMs(text);
  if (!d || !AFTER_WORDS.test(text)) return null;
  if (d.ms < 5_000 || d.ms > MAX_TIMER_MS) return null;
  // What to remind about: whatever follows ":" ("2 soatdan keyin eslat: choy"), else a plain timer.
  const colon = raw.indexOf(':');
  const note = colon >= 0 ? raw.slice(colon + 1).trim() : '';
  return {
    action: 'remind',
    repeat: false,
    remindAt: new Date(now.getTime() + d.ms),
    text: note || `⏰ Taymer (${d.match}) tugadi`,
    needsSearch: false,
    exact: false,
    reply: '',
  };
}
