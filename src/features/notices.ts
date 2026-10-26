import {
  defaultBusyReply,
  defaultFallbackReply,
  defaultOffHoursReply,
  defaultOwnerRequiredReply,
  defaultPersonalReply,
} from '../config/defaults.js';
import type { ContactLanguage } from './language.js';

/** Fixed texts sent to contacts (waiting / off-hours / busy notices). */
export type NoticeKind = 'personal' | 'ownerRequired' | 'fallback' | 'offHours' | 'busy';

const DEFAULTS: Record<NoticeKind, (owner: string) => string> = {
  personal: defaultPersonalReply,
  ownerRequired: defaultOwnerRequiredReply,
  fallback: defaultFallbackReply,
  offHours: defaultOffHoursReply,
  busy: defaultBusyReply,
};

const TRANSLATIONS: Record<'ru' | 'en', Record<NoticeKind, (owner: string) => string>> = {
  ru: {
    personal: (o) => `Это личный вопрос. ${o} ответит вам сам чуть позже 🙂`,
    ownerRequired: (o) => `На этот вопрос ${o} ответит сам, подождите немного 🙂`,
    fallback: (o) => `Сейчас небольшая проблема с ответом. ${o} ответит позже.`,
    offHours: (o) => `Здравствуйте! Сейчас нерабочее время. ${o} ответит после {start} 🙂`,
    busy: (o) => `${o} сейчас занят ({note}). Ответит примерно после {until} 🙂`,
  },
  en: {
    personal: (o) => `That's a personal question — ${o} will reply to you personally a bit later 🙂`,
    ownerRequired: (o) => `${o} will answer this one personally, please wait a little 🙂`,
    fallback: (o) => `There's a small problem replying right now. ${o} will get back to you later.`,
    offHours: (o) => `Hi! It's outside working hours now. ${o} will reply after {start} 🙂`,
    busy: (o) => `${o} is busy right now ({note}). They'll reply after about {until} 🙂`,
  },
};

const DIGRAPHS: Array<[RegExp, string]> = [
  [/o[‘’ʻʼ'`]/g, 'ў'],
  [/O[‘’ʻʼ'`]/g, 'Ў'],
  [/g[‘’ʻʼ'`]/g, 'ғ'],
  [/G[‘’ʻʼ'`]/g, 'Ғ'],
  [/sh/g, 'ш'],
  [/Sh|SH/g, 'Ш'],
  [/ch/g, 'ч'],
  [/Ch|CH/g, 'Ч'],
  [/yo/g, 'ё'],
  [/Yo|YO/g, 'Ё'],
  [/yu/g, 'ю'],
  [/Yu|YU/g, 'Ю'],
  [/ya/g, 'я'],
  [/Ya|YA/g, 'Я'],
  [/ye/g, 'е'],
  [/Ye|YE/g, 'Е'],
];
const LETTERS: Record<string, string> = {
  a: 'а', b: 'б', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'ҳ', i: 'и', j: 'ж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о',
  p: 'п', q: 'қ', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', x: 'х', y: 'й', z: 'з', c: 'с', w: 'в',
};

/**
 * Uzbek Latin → Uzbek Cyrillic (standard letter mapping). Placeholders like {start}, @usernames and
 * links are kept; an "e" at the start of a word becomes "э".
 */
export function latinToCyrillic(text: string): string {
  return text
    .split(/(\{[a-z]+\}|@\w+|https?:\/\/\S+)/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      let s = part.replace(/(^|[^\p{L}])([eE])/gu, (_, pre: string, e: string) => `${pre}${e === 'e' ? 'э' : 'Э'}`);
      for (const [re, to] of DIGRAPHS) s = s.replace(re, to);
      s = s.replace(/[’‘ʼʻ'`](?=\p{L})/gu, 'ъ');
      return s.replace(/[A-Za-z]/g, (ch) => {
        const lower = LETTERS[ch.toLowerCase()];
        if (!lower) return ch;
        return ch === ch.toLowerCase() ? lower : lower.toUpperCase();
      });
    })
    .join('');
}

/**
 * A notice in the contact's language. The owner's own (edited) texts are never rewritten except
 * Uzbek Latin → Cyrillic for contacts writing in Cyrillic; default texts have built-in translations.
 * `fill` substitutes the placeholders ({owner}, {note}, …).
 */
export function localizeNotice(
  kind: NoticeKind,
  template: string,
  ownerName: string,
  lang: ContactLanguage | null,
  fill: (t: string) => string = (t) => t,
): string {
  if (!lang || lang === 'uz-latn') return fill(template);
  if (lang === 'uz-cyrl') return latinToCyrillic(fill(template));
  const isDefault = template.trim() === DEFAULTS[kind](ownerName).trim();
  return fill(isDefault ? TRANSLATIONS[lang][kind](ownerName) : template);
}
