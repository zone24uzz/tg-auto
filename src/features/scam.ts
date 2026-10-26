import { normalizeForMatching } from '../classifiers/heuristics.js';

/**
 * Deterministic scam / phishing detector (Uzbek Latin & Cyrillic, Russian, English).
 * Runs before the paid classifier: a confident hit is never answered, and the owner is warned.
 * Weak signals alone (a link, the word "bonus") never trigger it — only combinations or
 * unambiguous requests (login codes, card CVV, "double your money").
 */
export interface ScamVerdict {
  score: number;
  /** Short labels of what matched (shown to the owner). */
  reasons: string[];
}

type Signal = { label: string; weight: number; re: RegExp };

/** "send / tell / give it to me" as a request (imperative forms only: "yuborildi" = "was sent" is not one). */
const ASK = String.raw`(?<!\p{L})(yubor(ing|gin|ib yubor\p{L}*|asanmi|asizmi)?|tashla(ng|b yubor\p{L}*)?|ayt(ing|ib yubor\p{L}*|asanmi|asizmi)?|ber(ing|ib yubor\p{L}*|asanmi|asizmi)?|jo'nat(ing|ib yubor\p{L}*)?|send|share|tell|скинь(те)?|отправь(те)?|пришли(те)?|скажи(те)?|перешли(те)?|продиктуй(те)?)(?!\p{L})`;
const CODE = String.raw`(kod|kodni|code|код)`;
const CODE_REQUEST = new RegExp(
  [
    String.raw`(sms|tasdiqlash|telegram|kirish|login|verification|confirmation|смс|код подтверждения)[^.!?\n]{0,30}${CODE}[^.!?\n]{0,40}${ASK}`,
    String.raw`${CODE}[^\n]{0,25}(keldi|kelgan|came|пришел|пришёл)[^\n]{0,80}${ASK}`,
    String.raw`(пришел|пришёл|пришло|придет|придёт)[^.!?\n]{0,30}(код|смс)[^.!?\n]{0,40}${ASK}`,
    String.raw`parol(ingni|ingizni)?\s*${ASK}`,
    String.raw`(send|tell) me (your|the) (password|code)`,
    String.raw`(скажи|скинь|пришли|отправь)(те)?( мне)? (пароль|код)`,
  ].join('|'),
  'u',
);

const SIGNALS: Signal[] = [
  // Account theft: asking for a login / SMS code or a password.
  { label: 'kod yoki parol so‘ralgan', weight: 0.95, re: CODE_REQUEST },
  // Bank card details.
  {
    label: 'karta ma’lumotlari so‘ralgan',
    weight: 0.95,
    re: /\b(cvv|cvc|cvv2)\b|karta(ning)? (orqasidagi|amal qilish muddati)|срок действия карты|код с обратной стороны|(card|karta|карт[аыу]) (number|raqam(ingiz|ing)?|номер)[^.!?\n]{0,40}(va|and|и) (muddat|expiry|срок|sms|kod|code|код)/u,
  },
  // "Double your money" / guaranteed profit.
  {
    label: 'kafolatlangan foyda / pulni ko‘paytirish',
    weight: 0.7,
    re: /(kuniga|haftasiga|oyiga|daily|per day|в день|в неделю|ежедневно)[^.!?\n]{0,25}\d+\s?(%|foiz|процент)|(ikki|uch) (baravar|barobar)|x2 |удво|double (your|the) (money|investment)|guaranteed (profit|return|income)|kafolatlangan (daromad|foyda)|гарантированн(ый|ая) (доход|прибыль)|без вложений|vloj(eniya)?siz|sarmoyasiz/u,
  },
  // Crypto / investment lure.
  {
    label: 'kripto / investitsiya taklifi',
    weight: 0.55,
    re: /airdrop|crypto|kripto|bitcoin|\busdt\b|\btrc ?20\b|binance|bybit|forex|treyding|trading signal|signal(lar)? kanal|p2p arbitra|арбитраж|инвестиц|investitsiya|invest qil|пассивный доход|passiv daromad/u,
  },
  // Prize / gift / free premium lures.
  {
    label: 'yutuq / sovg‘a vasvasasi',
    weight: 0.55,
    re: /yutib oldingiz|g'olib bo'ldingiz|sovrin(ni)? ol|bepul (telegram )?premium|premium (bepul|sovg'a)|вы выиграли|ваш приз|бесплатн(ый|ая) (премиум|premium)|подарок для вас|you (have )?won|claim your (prize|reward|gift)|free (telegram )?premium|giveaway winner/u,
  },
  // Easy-money job offers.
  {
    label: 'oson pul / masofaviy ish taklifi',
    weight: 0.5,
    re: /uyda (o'tirib|turib)[^.!?\n]{0,30}(\$|dollar|so'm|daromad|pul)|telefon orqali[^.!?\n]{0,20}(daromad|pul ishla)|работа на дому|оплата каждый день|заработок от \d|earn \$?\d+ (a|per) day|work from home and earn/u,
  },
  // Threats to the account ("it will be blocked unless…").
  {
    label: 'akkaunt bloklanishi bilan qo‘rqitish',
    weight: 0.5,
    re: /(akkaunt|akaunt|profil|hisob)(ingiz|ing)? (bloklanadi|o'chiriladi|o'chib qoladi)|аккаунт (будет )?(заблокир|удал)|account (will be )?(blocked|suspended|deleted)/u,
  },
  // Urgency + money transfer pressure.
  {
    label: 'shoshilinch pul o‘tkazish',
    weight: 0.45,
    re: /(tezda|zudlik bilan|shoshilinch|срочно|urgent(ly)?)[^.!?\n]{0,40}(pul|o'tkaz|karta|perevod|перевед|переведи|скинь|transfer|send money)/u,
  },
];

/** URL hosts that are typical for phishing and malware. */
const SUSPICIOUS_LINK: Signal = {
  label: 'shubhali havola',
  weight: 0.6,
  re: /\b(bit\.ly|tinyurl\.com|cutt\.ly|clck\.ru|goo\.su|is\.gd|t\.ly|rb\.gy|shorturl\.at)\/|https?:\/\/\d{1,3}(\.\d{1,3}){3}|xn--|https?:\/\/[^\s/]*(gift|prize|bonus|premium|free|verify|login|secure|wallet|airdrop|claim)[^\s/]*\.|https?:\/\/[^\s/]+\.(xyz|top|click|icu|shop|live|buzz|cfd|sbs|rest|lol)\b|https?:\/\/[^\s/]*(te1egram|telegrarn|teiegram|tg-?premium|telegram-?(gift|premium|login|verify))[^\s/]*|\.apk\b/u,
};

/** Score in 0..1: the best signal plus a share of the others (two medium lures add up). */
export function detectScam(rawText: string): ScamVerdict {
  const text = normalizeForMatching(rawText);
  if (!text) return { score: 0, reasons: [] };
  const hits = [...SIGNALS, SUSPICIOUS_LINK].filter((s) => s.re.test(text));
  if (hits.length === 0) return { score: 0, reasons: [] };
  const sorted = hits.map((h) => h.weight).sort((a, b) => b - a);
  const score = Math.min(1, sorted[0]! + sorted.slice(1).reduce((sum, w) => sum + w * 0.6, 0));
  return { score: Math.round(score * 100) / 100, reasons: hits.map((h) => h.label) };
}

/** Confident enough to never answer and to warn the owner. */
export const SCAM_THRESHOLD = 0.9;
