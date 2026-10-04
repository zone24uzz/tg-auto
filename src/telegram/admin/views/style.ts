import { RESPONSE_LENGTHS, RESPONSE_STYLES, type Settings } from '../../../settings/schema.js';
import { quote } from '../../common/html.js';
import { choiceBtn, editBtn } from '../controls.js';
import type { AdminKit } from '../kit.js';
import { Kb, show, type View } from '../ui.js';

const EFFORTS = [
  ['minimal', 'Minimal'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
] as const;

export function buildReasoning(s: Settings): View {
  const text = [
    '⚙️ <b>REASONING EFFORT</b>',
    '',
    `Hozir: <b>${s.reasoningEffort}</b>`,
    '',
    '• Minimal / Low — tezroq va arzonroq javoblar',
    '• Medium — muvozanat (tavsiya etiladi)',
    '• High — murakkab savollar uchun chuqurroq o‘ylash, sekinroq va qimmatroq',
    '',
    'ℹ️ Reasoning’ni qo‘llamaydigan modellar bu sozlamani e’tiborsiz qoldiradi.',
  ].join('\n');
  const kb = new Kb().row(...EFFORTS.map(([v, l]) => choiceBtn('re', v, s.reasoningEffort === v, l))).back('ai');
  return { text, keyboard: kb.build() };
}

type Style = (typeof RESPONSE_STYLES)[number];
export const STYLE_INFO: Record<Style, { label: string; desc: string }> = {
  NATURAL: { label: 'Natural', desc: 'oddiy, tabiiy suhbat ohangi' },
  FRIENDLY: { label: 'Friendly', desc: 'iliq va samimiy' },
  PROFESSIONAL: { label: 'Professional', desc: 'rasmiy, aniq va xushmuomala' },
  VERY_SHORT: { label: 'Very short', desc: 'juda qisqa, 1 jumla atrofida' },
  CUSTOM: { label: 'Custom', desc: 'pastdagi maxsus ko‘rsatma bo‘yicha' },
};

export function buildStyle(s: Settings): View {
  const lines = ['🎭 <b>RESPONSE STYLE</b>', '', `Hozir: <b>${STYLE_INFO[s.responseStyle].label}</b>`, ''];
  for (const st of RESPONSE_STYLES) lines.push(`• <b>${STYLE_INFO[st].label}</b> — ${STYLE_INFO[st].desc}`);
  lines.push(
    '',
    '✏️ Maxsus uslub ko‘rsatmasi:',
    s.customStylePrompt ? `<blockquote>${quote(s.customStylePrompt, 800)}</blockquote>` : '<i>(bo‘sh)</i>',
  );
  const kb = new Kb()
    .grid(
      RESPONSE_STYLES.map((st) => choiceBtn('rs', st, s.responseStyle === st, STYLE_INFO[st].label)),
      2,
    )
    .row(editBtn('csp', 'Maxsus uslub ko‘rsatmasi'))
    .back();
  return { text: lines.join('\n'), keyboard: kb.build() };
}

type Length = (typeof RESPONSE_LENGTHS)[number];
export const LENGTH_INFO: Record<Length, { label: string; desc: string }> = {
  SHORT: { label: 'Short', desc: '1–2 jumla, faqat eng muhimi' },
  NORMAL: { label: 'Normal', desc: 'odatdagi suhbat uzunligi (2–4 jumla)' },
  DETAILED: { label: 'Detailed', desc: 'batafsil tushuntirish, kerak bo‘lsa ro‘yxat bilan' },
};

export function buildLength(s: Settings): View {
  const lines = ['📏 <b>RESPONSE LENGTH</b>', '', `Hozir: <b>${LENGTH_INFO[s.responseLength].label}</b>`, ''];
  for (const l of RESPONSE_LENGTHS) lines.push(`• <b>${LENGTH_INFO[l].label}</b> — ${LENGTH_INFO[l].desc}`);
  const kb = new Kb()
    .row(...RESPONSE_LENGTHS.map((l) => choiceBtn('rl', l, s.responseLength === l, LENGTH_INFO[l].label)))
    .back();
  return { text: lines.join('\n'), keyboard: kb.build() };
}

export function registerStyle(kit: AdminKit): void {
  const { router, deps } = kit;
  router.action('re', async (ctx) => {
    await show(ctx, buildReasoning(await deps.settings.get()));
  });
  router.action('st', async (ctx) => {
    await show(ctx, buildStyle(await deps.settings.get()));
  });
  router.action('ln', async (ctx) => {
    await show(ctx, buildLength(await deps.settings.get()));
  });
}
