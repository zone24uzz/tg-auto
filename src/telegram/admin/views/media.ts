import type { Settings } from '../../../settings/schema.js';
import { choiceBtn, editBtn, presetBtns, toggleBtn } from '../controls.js';
import type { AdminKit } from '../kit.js';
import { Kb, NOP, btn, num, show, yesNo, type View } from '../ui.js';

export const MEDIA_SCREENS = ['md.i', 'md.v', 'md.vd', 'md.n', 'md.d'] as const;
export type MediaScreen = (typeof MEDIA_SCREENS)[number];

const OVERSIZED: Record<Settings['oversizedMediaAction'], string> = {
  NOTICE: 'xushmuomala javob',
  IGNORE: 'jim o‘tkazish',
  OWNER: 'menga yuborish',
};

const VOICE_MODES: Record<Settings['voiceResponseMode'], string> = {
  text: 'Matn',
  voice: 'Ovoz',
  adaptive: 'Moslashuvchan',
};

const LIMIT_NOTE =
  'ℹ️ Telegram’ning bulutli Bot API’si botga 20 MB dan katta fayllarni yuklab olishga ruxsat bermaydi — bunday fayllar tahlil qilinmaydi.';

const secs = (v: number): string => (v >= 60 && v % 60 === 0 ? `${v / 60} daq` : `${v} s`);
const short = (v: number): string => (v >= 60 && v % 60 === 0 ? `${v / 60}m` : `${v}s`);
const kChars = (v: number): string => (v >= 1000 ? `${v / 1000}k` : String(v));

function commonLines(s: Settings): string[] {
  return ['', `📦 Maks. media hajmi: <b>${s.maxMediaSizeMb} MB</b> · Juda katta fayl: <b>${OVERSIZED[s.oversizedMediaAction]}</b>`, LIMIT_NOTE];
}

function commonRows(kb: Kb, s: Settings, screen: MediaScreen): Kb {
  return kb
    .row(btn('📦 MB:', NOP), ...presetBtns('ms', [5, 10, 20, 50], s.maxMediaSizeMb, String, screen))
    .row(
      ...(Object.keys(OVERSIZED) as Array<Settings['oversizedMediaAction']>).map((a) =>
        choiceBtn('oma', a, s.oversizedMediaAction === a, a === 'NOTICE' ? 'Javob' : a === 'IGNORE' ? 'Jim' : 'Menga', screen),
      ),
    )
    .row(editBtn('umt', 'Noma’lum media matni', screen), editBtn('mlt', 'Katta fayl matni', screen))
    .back();
}

export function buildImage(s: Settings): View {
  const text = [
    '📷 <b>IMAGE ANALYSIS</b>',
    '',
    `Rasm tahlili: ${yesNo(s.imageAnalysisEnabled)}`,
    `Rasmning o‘zini javob modeliga ham yuborish: ${yesNo(s.attachImageToReply)} (aniqroq, lekin qimmatroq)`,
    ...commonLines(s),
  ].join('\n');
  const kb = new Kb()
    .row(toggleBtn('ie', s.imageAnalysisEnabled, 'Rasm tahlili'))
    .row(toggleBtn('air', s.attachImageToReply, 'Rasmni javobga ilova qilish'));
  return { text, keyboard: commonRows(kb, s, 'md.i').build() };
}

export function buildVoice(s: Settings): View {
  const text = [
    '🎙 <b>VOICE ANALYSIS</b>',
    '',
    `Ovozli xabarlar: ${yesNo(s.voiceAnalysisEnabled)} · Audio fayllar: ${yesNo(s.audioAnalysisEnabled)}`,
    `Maks. davomiylik: <b>${secs(s.maxAudioDurationSec)}</b>`,
    `Javob turi: <b>${VOICE_MODES[s.voiceResponseMode]}</b>`,
    '• Matn — doim matn bilan javob',
    '• Ovoz — ovozli xabarga ovoz bilan javob',
    '• Moslashuvchan — vaziyatga qarab',
    'ℹ️ Ovozli javob uchun TTS’ni qo‘llaydigan provayder kerak (🧠 AI Model → 🔊 TTS).',
    ...commonLines(s),
  ].join('\n');
  const kb = new Kb()
    .row(toggleBtn('ve', s.voiceAnalysisEnabled, 'Ovozli'), toggleBtn('aue', s.audioAnalysisEnabled, 'Audio'))
    .row(btn('⏱', NOP), ...presetBtns('ad', [60, 180, 300, 600, 1800], s.maxAudioDurationSec, short))
    .row(
      ...(Object.keys(VOICE_MODES) as Array<Settings['voiceResponseMode']>).map((m) =>
        choiceBtn('vrm', m, s.voiceResponseMode === m, VOICE_MODES[m]),
      ),
    )
    .row(btn('🔊 TTS modeli', 'ai.t|tts'));
  return { text, keyboard: commonRows(kb, s, 'md.v').build() };
}

function frameRows(kb: Kb, s: Settings, screen: MediaScreen): Kb {
  return kb
    .row(btn('🖼 Har:', NOP), ...presetBtns('fi', [2, 5, 10, 20], s.frameSampleIntervalSec, (v) => `${v}s`, screen))
    .row(btn('🎞 Kadr:', NOP), ...presetBtns('mf', [3, 6, 10, 15], s.maxFrames, String, screen));
}

export function buildVideo(s: Settings): View {
  const text = [
    '🎥 <b>VIDEO ANALYSIS</b>',
    '',
    `Video tahlili: ${yesNo(s.videoAnalysisEnabled)}`,
    `Maks. davomiylik: <b>${secs(s.maxVideoDurationSec)}</b>`,
    `Kadrlar: har <b>${s.frameSampleIntervalSec} s</b> da bittadan, maks. <b>${s.maxFrames}</b> ta (+ ovoz transkripsiyasi)`,
    ...commonLines(s),
  ].join('\n');
  const kb = new Kb()
    .row(toggleBtn('vie', s.videoAnalysisEnabled, 'Video tahlili'))
    .row(btn('⏱', NOP), ...presetBtns('vd', [60, 120, 180, 300, 600], s.maxVideoDurationSec, short));
  return { text, keyboard: commonRows(frameRows(kb, s, 'md.vd'), s, 'md.vd').build() };
}

export function buildVideoNote(s: Settings): View {
  const text = [
    '⭕ <b>VIDEO NOTE ANALYSIS</b>',
    '',
    `Dumaloq video tahlili: ${yesNo(s.videoNoteAnalysisEnabled)}`,
    'Dumaloq videolar 60 soniyagacha bo‘ladi; kadrlar va ovoz video sozlamalari bo‘yicha tahlil qilinadi.',
    `Kadrlar: har <b>${s.frameSampleIntervalSec} s</b>, maks. <b>${s.maxFrames}</b> ta`,
    ...commonLines(s),
  ].join('\n');
  const kb = new Kb().row(toggleBtn('vne', s.videoNoteAnalysisEnabled, 'Dumaloq video tahlili'));
  return { text, keyboard: commonRows(frameRows(kb, s, 'md.n'), s, 'md.n').build() };
}

export function buildDocument(s: Settings): View {
  const text = [
    '📁 <b>FILE ANALYSIS</b>',
    '',
    `Fayl tahlili: ${yesNo(s.documentAnalysisEnabled)} (PDF, DOCX, XLSX, CSV, TXT…)`,
    `Maks. fayl hajmi: <b>${s.maxDocumentSizeMb} MB</b>`,
    `Maks. o‘qiladigan matn: <b>${num(s.maxDocumentChars)}</b> belgi`,
    ...commonLines(s),
  ].join('\n');
  const kb = new Kb()
    .row(toggleBtn('de', s.documentAnalysisEnabled, 'Fayl tahlili'))
    .row(btn('📦 MB:', NOP), ...presetBtns('ds', [2, 5, 10, 20], s.maxDocumentSizeMb))
    .row(btn('🔤', NOP), ...presetBtns('dc', [10_000, 30_000, 50_000, 100_000], s.maxDocumentChars, kChars));
  return { text, keyboard: commonRows(kb, s, 'md.d').build() };
}

const BUILDERS: Record<MediaScreen, (s: Settings) => View> = {
  'md.i': buildImage,
  'md.v': buildVoice,
  'md.vd': buildVideo,
  'md.n': buildVideoNote,
  'md.d': buildDocument,
};

export function registerMedia(kit: AdminKit): void {
  for (const screen of MEDIA_SCREENS) {
    kit.router.action(screen, async (ctx) => {
      await show(ctx, BUILDERS[screen](await kit.deps.settings.get()));
    });
  }
}
