/**
 * Which language (and script) the contact writes in, so the reply can match it exactly.
 * Deterministic and cheap: runs on every reply. Unclear text → null (the model decides).
 */
export type ContactLanguage = 'uz-latn' | 'uz-cyrl' | 'ru' | 'en';

const LANGUAGE_NAMES: Record<ContactLanguage, string> = {
  'uz-latn': 'Uzbek in the Latin script',
  'uz-cyrl': 'Uzbek in the Cyrillic script',
  ru: 'Russian',
  en: 'English',
};

/** Letters only Uzbek Cyrillic uses (ў қ ғ ҳ). */
const UZ_CYRILLIC_LETTERS = /[ўқғҳ]/iu;
/** Frequent Uzbek words written in Cyrillic (without the special letters). */
const UZ_CYRILLIC_WORDS = /(?<!\p{L})(салом|ассалому|рахмат|раҳмат|яхши|нима|қалай|калай|бугун|эртага|кечирасиз|илтимос|бор|йўқ|йук|керак|мен|сиз|сен|билан|учун|ака|опа|ука|хоп|майли)(?!\p{L})/iu;
/** Uzbek Latin markers: o‘/g‘ (any apostrophe), sh/ch digraph words and common words. */
const UZ_LATIN_MARKERS = /[og][‘’ʻʼ'`]|(?<!\p{L})(salom|assalomu|rahmat|raxmat|yaxshi|nima|qalay|bugun|ertaga|kechirasiz|iltimos|bormi|yo'q|yoq|kerak|men|siz|sen|bilan|uchun|aka|opa|xop|mayli|qachon|qayer|necha|qancha|narxi|bo'ladi|boladi|emas|ham|endi|hozir)(?!\p{L})/iu;
const ENGLISH_WORDS = /(?<!\p{L})(the|and|you|your|is|are|what|how|when|where|please|thanks|thank|hello|hi|hey|can|could|would|price|need|want|have|do|does)(?!\p{L})/iu;

/** Language of a contact's text, or null when it is too short / mixed to tell. */
export function detectLanguage(text: string): ContactLanguage | null {
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length < 2) return null;
  const cyrillic = (letters.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  const latin = (letters.match(/\p{Script=Latin}/gu) ?? []).length;
  if (cyrillic === 0 && latin === 0) return null;
  if (cyrillic >= latin) {
    if (UZ_CYRILLIC_LETTERS.test(text) || UZ_CYRILLIC_WORDS.test(text)) return 'uz-cyrl';
    return 'ru';
  }
  const uz = (text.match(new RegExp(UZ_LATIN_MARKERS.source, 'giu')) ?? []).length;
  const en = (text.match(new RegExp(ENGLISH_WORDS.source, 'giu')) ?? []).length;
  if (uz === 0 && en === 0) return null; // e.g. a name or a link: let the model decide
  return en > uz ? 'en' : 'uz-latn';
}

/** The explicit prompt line for the detected language (empty when unknown). */
export function languageInstruction(lang: ContactLanguage | null): string {
  if (!lang) return '';
  return `The contact's latest message is in ${LANGUAGE_NAMES[lang]}: write your whole reply in ${LANGUAGE_NAMES[lang]} (switch only if the contact switches).`;
}
