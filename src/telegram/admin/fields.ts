import type { SettingKey } from '../../settings/schema.js';
import { SettingValidationError } from '../../settings/settings.service.js';

export type FieldKind = 'bool' | 'num' | 'enum' | 'text' | 'optText';

export interface FieldDef {
  key: SettingKey;
  kind: FieldKind;
  /** Callback data of the screen shown after a change. */
  screen: string;
  /** Uzbek label used in the ✏️ edit prompt. */
  label: string;
  hint?: string;
  /** Text fields: sending "-" stores an empty string. */
  allowEmpty?: boolean;
}

/**
 * Short codes for settings changed through the generic `sv` (set value) and `ed` (edit text)
 * callbacks — keeps callback_data far below Telegram's 64-byte limit.
 */
export const FIELDS: Readonly<Record<string, FieldDef>> = {
  // auto reply
  ae: { key: 'autoReplyEnabled', kind: 'bool', screen: 'ar', label: 'Avtojavob' },
  lw: { key: 'logWhenDisabled', kind: 'bool', screen: 'ar', label: 'O‘chiq paytda saqlash' },
  nw: { key: 'notifyWhenDisabled', kind: 'bool', screen: 'ar', label: 'O‘chiq paytda xabar berish' },
  // reply rules
  rm: { key: 'replyMode', kind: 'enum', screen: 'rr', label: 'Javob rejimi' },
  um: { key: 'unknownUserMode', kind: 'enum', screen: 'rr', label: 'Noma’lum foydalanuvchilar' },
  nm: { key: 'notifyManualMessages', kind: 'bool', screen: 'rr', label: 'Qo‘lda rejim xabarlari' },
  nv: { key: 'notifyVipMessages', kind: 'bool', screen: 'rr', label: 'VIP xabarlari' },
  // AI
  re: { key: 'reasoningEffort', kind: 'enum', screen: 're', label: 'Reasoning effort' },
  tv: { key: 'ttsVoice', kind: 'optText', screen: 'ai.t|tts', label: 'TTS ovozi', hint: 'Masalan: alloy, Kore. «-» — standart ovoz.' },
  lc: { key: 'useLlmClassifier', kind: 'bool', screen: 'pq', label: 'LLM klassifikator' },
  // style
  rs: { key: 'responseStyle', kind: 'enum', screen: 'st', label: 'Javob uslubi' },
  csp: {
    key: 'customStylePrompt',
    kind: 'text',
    screen: 'st',
    label: 'Maxsus uslub ko‘rsatmasi',
    hint: 'Maks. 2000 belgi. «-» — tozalash.',
    allowEmpty: true,
  },
  rl: { key: 'responseLength', kind: 'enum', screen: 'ln', label: 'Javob uzunligi' },
  // personal questions
  pd: { key: 'personalDetectionEnabled', kind: 'bool', screen: 'pq', label: 'Shaxsiy savollarni aniqlash' },
  pt: { key: 'personalThreshold', kind: 'num', screen: 'pq', label: 'Ishonch chegarasi', hint: '0.5 – 0.99' },
  prt: { key: 'personalReplyText', kind: 'text', screen: 'pq', label: 'Kutish xabari matni', hint: '1–1000 belgi.' },
  ort: { key: 'ownerRequiredReplyText', kind: 'text', screen: 'pq', label: 'Qaroringiz kerak bo‘lgandagi kutish matni', hint: '1–1000 belgi.' },
  ua: { key: 'uncertainAction', kind: 'enum', screen: 'pq', label: 'Noaniq holatda' },
  pc: { key: 'personalNoticeCooldownMinutes', kind: 'num', screen: 'pq', label: 'Kutish xabari oralig‘i (daqiqa)' },
  // media
  ie: { key: 'imageAnalysisEnabled', kind: 'bool', screen: 'md.i', label: 'Rasm tahlili' },
  air: { key: 'attachImageToReply', kind: 'bool', screen: 'md.i', label: 'Rasmni javobga ilova qilish' },
  ve: { key: 'voiceAnalysisEnabled', kind: 'bool', screen: 'md.v', label: 'Ovozli xabarlar tahlili' },
  aue: { key: 'audioAnalysisEnabled', kind: 'bool', screen: 'md.v', label: 'Audio fayllar tahlili' },
  vrm: { key: 'voiceResponseMode', kind: 'enum', screen: 'md.v', label: 'Javob turi' },
  vie: { key: 'videoAnalysisEnabled', kind: 'bool', screen: 'md.vd', label: 'Video tahlili' },
  vne: { key: 'videoNoteAnalysisEnabled', kind: 'bool', screen: 'md.n', label: 'Dumaloq video tahlili' },
  de: { key: 'documentAnalysisEnabled', kind: 'bool', screen: 'md.d', label: 'Fayl tahlili' },
  ms: { key: 'maxMediaSizeMb', kind: 'num', screen: 'md.i', label: 'Maks. media hajmi (MB)' },
  ad: { key: 'maxAudioDurationSec', kind: 'num', screen: 'md.v', label: 'Maks. audio davomiyligi (s)' },
  vd: { key: 'maxVideoDurationSec', kind: 'num', screen: 'md.vd', label: 'Maks. video davomiyligi (s)' },
  fi: { key: 'frameSampleIntervalSec', kind: 'num', screen: 'md.vd', label: 'Kadr oralig‘i (s)' },
  mf: { key: 'maxFrames', kind: 'num', screen: 'md.vd', label: 'Maks. kadrlar' },
  ds: { key: 'maxDocumentSizeMb', kind: 'num', screen: 'md.d', label: 'Maks. fayl hajmi (MB)' },
  dc: { key: 'maxDocumentChars', kind: 'num', screen: 'md.d', label: 'Maks. matn uzunligi (belgi)' },
  oma: { key: 'oversizedMediaAction', kind: 'enum', screen: 'md.i', label: 'Juda katta fayl' },
  umt: { key: 'unsupportedMediaText', kind: 'text', screen: 'md.i', label: 'Qo‘llab-quvvatlanmagan media matni', hint: '1–1000 belgi.' },
  mlt: { key: 'mediaTooLargeText', kind: 'text', screen: 'md.i', label: '«Fayl juda katta» matni', hint: '1–1000 belgi.' },
  // behaviour
  dm: { key: 'responseDelayMode', kind: 'enum', screen: 'adv.d', label: 'Kechikish rejimi' },
  dmn: { key: 'customDelayMinSec', kind: 'num', screen: 'adv.d', label: 'Min. kechikish (s)', hint: '0–120' },
  dmx: { key: 'customDelayMaxSec', kind: 'num', screen: 'adv.d', label: 'Maks. kechikish (s)', hint: '0–300' },
  ti: { key: 'typingIndicator', kind: 'bool', screen: 'adv.d', label: '«Yozmoqda…» ko‘rsatkichi' },
  db: { key: 'debounceSeconds', kind: 'num', screen: 'adv.c', label: 'Ketma-ket xabarlarni kutish (s)' },
  hw: { key: 'historyWindow', kind: 'num', screen: 'adv.c', label: 'Kontekst oynasi (xabar)' },
  se: { key: 'summaryEnabled', kind: 'bool', screen: 'adv.c', label: 'Suhbat xulosasi' },
  sem: { key: 'summaryEveryMessages', kind: 'num', screen: 'adv.c', label: 'Xulosa har N xabarda' },
  // limits
  mpm: { key: 'maxMessagesPerMinute', kind: 'num', screen: 'adv.l', label: 'Daqiqasiga maks. xabar (bitta chat)', hint: '1–1000' },
  apu: { key: 'maxAiRequestsPerUserPerHour', kind: 'num', screen: 'adv.l', label: 'Foydalanuvchiga soatiga AI so‘rov', hint: '1–100000' },
  gai: { key: 'globalAiRequestsPerMinute', kind: 'num', screen: 'adv.l', label: 'Umumiy AI so‘rov / daqiqa', hint: '1–100000' },
  mc: { key: 'maxDailyAiCostUsd', kind: 'num', screen: 'adv.l', label: 'Kunlik AI xarajat limiti ($)', hint: '0 = cheksiz. Masalan: 1.5' },
  // retention
  mr: { key: 'messageRetentionDays', kind: 'num', screen: 'adv.r', label: 'Xabarlarni saqlash (kun)' },
  mdr: { key: 'mediaRetentionDays', kind: 'num', screen: 'adv.r', label: 'Media saqlash (kun)' },
  alr: { key: 'aiLogRetentionDays', kind: 'num', screen: 'adv.r', label: 'AI loglarni saqlash (kun)' },
  rrm: { key: 'retainRawMedia', kind: 'bool', screen: 'adv.r', label: 'Xom media fayllarni saqlash' },
  // admin notifications
  ne: { key: 'notifyEdits', kind: 'bool', screen: 'adv.n', label: 'Tahrirlar haqida' },
  nd: { key: 'notifyDeletes', kind: 'bool', screen: 'adv.n', label: 'O‘chirishlar haqida' },
  noa: { key: 'notifyOwnerAttention', kind: 'bool', screen: 'adv.n', label: 'Owner attention' },
  // misc
  on: { key: 'ownerName', kind: 'text', screen: 'adv', label: 'Egasining ismi', hint: '1–64 belgi.' },
  fbt: { key: 'fallbackReplyText', kind: 'text', screen: 'adv', label: 'Zaxira javob matni', hint: '1–1000 belgi.' },
};

/** Value carried in a `sv` callback → typed value (SettingsService validates ranges/enums). */
export function parseCallbackValue(def: FieldDef, raw: string): unknown {
  switch (def.kind) {
    case 'bool':
      if (raw === '1') return true;
      if (raw === '0') return false;
      throw new SettingValidationError(def.key, 'invalid boolean');
    case 'num': {
      const n = Number(raw);
      if (raw === '' || !Number.isFinite(n)) throw new SettingValidationError(def.key, 'invalid number');
      return n;
    }
    case 'optText':
      return raw === '-' ? null : raw;
    case 'text':
      return raw === '-' && def.allowEmpty ? '' : raw;
    case 'enum':
    default:
      return raw;
  }
}

/** Admin's text message → typed value for a ✏️ edit. */
export function parseTextValue(def: FieldDef, text: string): unknown {
  const t = text.trim();
  switch (def.kind) {
    case 'num': {
      const n = Number(t.replace(/\s+/g, '').replace(',', '.'));
      if (t === '' || !Number.isFinite(n)) throw new SettingValidationError(def.key, 'raqam yuboring');
      return n;
    }
    case 'optText':
      return t === '-' || t === '' ? null : t;
    case 'text':
      return t === '-' && def.allowEmpty ? '' : text;
    default:
      throw new SettingValidationError(def.key, 'bu sozlama matn orqali o‘zgartirilmaydi');
  }
}
