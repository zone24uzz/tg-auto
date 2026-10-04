import type { Settings } from '../../../settings/schema.js';
import { quote } from '../../common/html.js';
import { choiceBtn, editBtn, presetBtns, toggleBtn } from '../controls.js';
import type { AdminKit } from '../kit.js';
import { Kb, btn, NOP, show, yesNo, type View } from '../ui.js';

const THRESHOLDS = [0.6, 0.7, 0.8, 0.9] as const;
const COOLDOWNS = [0, 15, 30, 60, 180] as const;

const minutes = (m: number): string => (m === 0 ? 'har safar' : m >= 60 ? `${m / 60} soat` : `${m} daq`);

export function buildPersonal(s: Settings): View {
  const text = [
    '🔒 <b>PERSONAL QUESTIONS</b>',
    '',
    'Shaxsiy savollar (qayerdasan, nima qilyapsan, rejalar, oila, sog‘liq…) AI tomonidan javoblanmaydi: foydalanuvchiga kutish xabari yuboriladi va xabar sizning navbatingizga (🔔) tushadi.',
    '',
    `Aniqlash: ${yesNo(s.personalDetectionEnabled)}`,
    `Ishonch chegarasi: <b>${s.personalThreshold}</b> (pastroq — ko‘proq savol shaxsiy deb hisoblanadi)`,
    `Noaniq holatda: <b>${s.uncertainAction === 'OWNER' ? 'menga yuborish (xavfsiz)' : 'AI javob bersin'}</b>`,
    `Kutish xabari oralig‘i: <b>${minutes(s.personalNoticeCooldownMinutes)}</b> (bir chatga qayta yuborilmaydi)`,
    `LLM klassifikator: ${yesNo(s.useLlmClassifier)} (o‘chirilsa faqat kalit so‘zlar bo‘yicha)`,
    '',
    'Kutish xabari (shaxsiy savol):',
    `<blockquote>${quote(s.personalReplyText, 500)}</blockquote>`,
    'Kutish xabari (sizning qaroringiz kerak — narx, muddat, va’da…):',
    `<blockquote>${quote(s.ownerRequiredReplyText, 500)}</blockquote>`,
  ].join('\n');
  const kb = new Kb()
    .row(toggleBtn('pd', s.personalDetectionEnabled, 'Aniqlash yoqilgan'))
    .row(btn('🎯 Chegara:', NOP), ...presetBtns('pt', THRESHOLDS, s.personalThreshold))
    .row(btn('❓ Noaniq:', NOP), choiceBtn('ua', 'OWNER', s.uncertainAction === 'OWNER', 'Menga'), choiceBtn('ua', 'AI', s.uncertainAction === 'AI', 'AI'))
    .row(btn('⏱ Oraliq:', NOP))
    .row(...presetBtns('pc', COOLDOWNS, s.personalNoticeCooldownMinutes, (m) => (m === 0 ? '0' : m >= 60 ? `${m / 60}h` : `${m}m`)))
    .row(toggleBtn('lc', s.useLlmClassifier, 'LLM klassifikator'))
    .row(editBtn('prt', 'Shaxsiy savol matni'))
    .row(editBtn('ort', 'Qaror kerak matni'))
    .back();
  return { text, keyboard: kb.build() };
}

export function registerPersonal(kit: AdminKit): void {
  kit.router.action('pq', async (ctx) => {
    await show(ctx, buildPersonal(await kit.deps.settings.get()));
  });
}
