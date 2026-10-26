/** Default user-facing texts and the default owner prompt. All are editable from the admin bot. */

export function defaultPersonalReply(ownerName: string): string {
  return `Bu shaxsiy savol ekan. ${ownerName} keyinroq o‘zi javob beradi 🙂`;
}

export function defaultOwnerRequiredReply(ownerName: string): string {
  return `Bu savolga ${ownerName} o‘zi aniq javob beradi, biroz kuting 🙂`;
}

/** Off-hours notice. Placeholders: {owner}, {start} (start of working hours). */
export function defaultOffHoursReply(ownerName: string): string {
  return `Assalomu alaykum! Hozir ish vaqtidan tashqari. ${ownerName} {start} dan keyin javob beradi 🙂`;
}

/** "Busy now" notice. Placeholders: {owner}, {note} (e.g. "uchrashuvda"), {until} (HH:MM). */
export function defaultBusyReply(ownerName: string): string {
  return `${ownerName} hozir band ({note}). Taxminan {until} dan keyin javob beradi 🙂`;
}

export function defaultFallbackReply(ownerName: string): string {
  return `Hozir javob berishda kichik muammo bor. ${ownerName} keyinroq javob beradi.`;
}

export function defaultUnsupportedMediaReply(ownerName: string): string {
  return `Bu turdagi faylni hozircha ko‘ra olmayman. ${ownerName} keyinroq o‘zi qarab chiqadi.`;
}

export function defaultMediaTooLargeReply(ownerName: string): string {
  return `Fayl juda katta ekan, uni avtomatik ko‘rib chiqa olmadim. ${ownerName} keyinroq qarab chiqadi.`;
}

/**
 * Default OWNER prompt: describes who the owner is and what the assistant may talk about.
 * The immutable safety core lives in src/conversations/system-core.ts and always takes precedence.
 */
export function defaultOwnerPrompt(ownerName: string): string {
  return [
    `Siz ${ownerName}ning Telegram yordamchisisiz va uning shaxsiy chatlaridagi xabarlarga qisqa va tabiiy javob berasiz. ${ownerName} band, bo‘sh yoki qayerdaligi haqida hech narsa demang.`,
    `Suhbatdosh qaysi tilda yozsa (o‘zbek, rus yoki ingliz), o‘sha tilda javob bering.`,
    `${ownerName} haqida faqat shu yerda yozilgan faktlarni ishlating. Bilmagan narsangizni o‘ylab topmang.`,
    `Ish bo‘yicha savollarda (xizmatlar, narx, muddat, texnologiyalar) umumiy va foydali javob bering; aniq narx yoki va’da kerak bo‘lsa, ${ownerName} o‘zi aniqlashtirishini ayting.`,
  ].join('\n');
}

export const STYLE_INSTRUCTIONS = {
  NATURAL:
    'Write like a normal person texting on Telegram: plain sentences, no headings, no markdown, no lists unless truly needed, at most one emoji and only when it fits.',
  FRIENDLY: 'Warm and friendly, casual Telegram tone, light emoji use is fine (max 2), no markdown or headings.',
  PROFESSIONAL: 'Polite and professional but still concise and human; no markdown, no headings, no emoji.',
  VERY_SHORT: 'Extremely brief: one short sentence whenever possible. No markdown, no emoji.',
  CUSTOM: '',
} as const;

export const LENGTH_PROFILES = {
  SHORT: { instruction: 'Answer in 1-3 short sentences.', maxOutputTokens: 300 },
  NORMAL: { instruction: 'Keep the answer Telegram-sized: a few sentences, only as long as needed.', maxOutputTokens: 700 },
  DETAILED: {
    instruction: 'You may give a longer explanation when it genuinely helps, but stay focused and skip filler.',
    maxOutputTokens: 1600,
  },
} as const;

export type ResponseStyle = keyof typeof STYLE_INSTRUCTIONS;
export type ResponseLength = keyof typeof LENGTH_PROFILES;
