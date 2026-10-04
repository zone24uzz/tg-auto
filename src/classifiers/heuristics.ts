/**
 * Fast, deterministic signals (Uzbek Latin/Cyrillic, Russian, English).
 * They run before the LLM classifier, act as a safety net when it is unavailable,
 * and can force owner handling for unambiguous personal questions.
 */

export interface HeuristicSignals {
  /** 0..1 – how strongly the text looks like a personal question for the owner. */
  personalScore: number;
  /** Personal sub-type driving the category (money/health → SENSITIVE). */
  personalKind?: 'location' | 'company' | 'availability' | 'money' | 'relationship' | 'family' | 'health' | 'opinion';
  businessScore: number;
  spamScore: number;
  injectionSuspected: boolean;
  isGreetingOnly: boolean;
  matched: string[];
}

/** Lowercase, unify apostrophes (o‘ / o' / oʻ / o`), collapse whitespace. */
export function normalizeForMatching(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʻʼ`´]/g, "'")
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

type Rule = { re: RegExp; weight: number; label: string };
type PersonalRule = Rule & { kind: NonNullable<HeuristicSignals['personalKind']> };

const PERSONAL: PersonalRule[] = [
  // where are you
  { kind: 'location', weight: 0.95, label: 'where-are-you', re: /\bqa(y)?erda(san|siz|sizlar)\b|hozir qa(y)?erda|qa(y)?erda yuribsan|қа(й)?ерда(сан|сиз)|где ты|ты где|где вы сейчас|where are (you|u)\b|where r u\b/u },
  // who are you with
  { kind: 'company', weight: 0.95, label: 'who-with', re: /\bkim bilan\b|ким билан|с кем (ты|вы)|who are (you|u) with/u },
  // availability / plans / meeting
  {
    kind: 'availability',
    weight: 0.92,
    label: 'availability',
    re: /\bbo'?sh(misan|misiz|san|siz|mi)\b|\bbo'?sh bo'?lasan|бўш(мисан|мисиз|сан)|\bband(misan|misiz)\b|uchrashamiz|uchrashaylik|uchrashsak|chiqamiz(mi)?\b|chiqasan(mi)?\b|kelasan(mi)?\b|kelasiz(mi)?\b|kelyapsan(mi)?|kelyapsiz(mi)?|kelolasan|kela olasan|kelmaysan|ketyapsan|келасан|келасиз|учрашамиз|свобод(ен|на|ны)|встретимся|придешь|придете|ты придешь|are (you|u) free|are (you|u) coming|(come|coming) tomorrow|meet (up|tonight|today|tomorrow)|free tonight|tonight\?/u,
  },
  // why didn't you come / where were you
  { kind: 'availability', weight: 0.9, label: 'why-absent', re: /nega kelmad|nima uchun kelmad|nimaga kelmad|qayerda eding|почему (ты )?не приш|где ты был|why didn'?t (you|u) come/u },
  // money / lending
  {
    kind: 'money',
    weight: 0.95,
    label: 'money',
    re: /pul berib tur|pul bera olasan|pul berasan|pul kerak edi|pul qarz|qarz(ga)? ber|qarz bera|qarzing|пул бериб|қарз|в долг|одолжи|занять (денег|деньги)|дай денег|lend me|borrow (some )?money|can i borrow|loan me/u,
  },
  // relationships / love
  {
    kind: 'relationship',
    weight: 0.93,
    label: 'relationship',
    re: /\b(qiz|yigit|sevgiling|sevgilim) bilan\b|sevasan(mi)?|yaxshi ko'rasan(mi)?|yoqtirasan(mi)?|o'rtangizda|orangizda nima|o'rtalaringda|севасан|любишь|ты любишь|с девушкой|с парнем|между вами|girlfriend|boyfriend|do (you|u) love|between (you|u) and|are (you|u) dating/u,
  },
  // family
  {
    kind: 'family',
    weight: 0.85,
    label: 'family',
    re: /\boilang\b|oilangiz|\bonang\b|\bdadang\b|ota-onang|uylan(asan|ding|ish)|turmush|xotining|eringiz|\bkelin(ingiz|ing)?\b|оилан|семь(я|е)|твои родители|(?<!\p{L})(жена|муж|мужем)(?!\p{L})|your (family|wife|husband|parents)|are (you|u) married/u,
  },
  // health
  { kind: 'health', weight: 0.85, label: 'health', re: /kasal(misan|misiz|bo'ldingmi)|sog'lig'?ing|o'zingni qanday his|болеешь|заболел|are (you|u) sick|how is your health/u },
  // personal permission / owner's own opinion or decision
  {
    kind: 'opinion',
    weight: 0.65,
    label: 'owner-decision',
    re: /\bruxsat ber|rozimisan|rozi bo'lasan|sen nima deysan|o'zing nima deysan|shaxsan sen|разрешишь|ты не против|what do you personally think|your permission/u,
  },
];

const BUSINESS: Rule[] = [
  { label: 'price', weight: 0.8, re: /narx|qancha turadi|necha pul|qanchaga|nech pul|baho|to'lov|нарх|цена|сколько стоит|стоимость|price|cost|how much|quote/ },
  { label: 'website', weight: 0.75, re: /\bsayt|web ?sayt|website|veb|landing|internet[- ]do'kon|сайт|веб|web app|telegram bot|bot yasa|bot qil/ },
  { label: 'work', weight: 0.7, re: /loyiha|buyurtma|xizmat|ish vaqt|portfolio|portfel|rezyume|frontend|backend|react|next\.?js|vue|node|dizayn|design|ui\/ux|dastur|заказ|услуг|проект|портфолио|services?\b|project|hire|freelance|deadline|muddat/ },
];

const SPAM: Rule[] = [
  { label: 'crypto', weight: 0.6, re: /airdrop|crypto|kripto|bitcoin|usdt|binance|forex|investitsiya|инвестиц|заработ(ок|ай)|earn \$|казино|casino|bonus|бонус|ставк|betting/ },
  { label: 'link', weight: 0.3, re: /https?:\/\/|t\.me\/|bit\.ly/ },
  { label: 'promo', weight: 0.4, re: /reklama|promo|скидк|подпишись|subscribe|click here|bosing/ },
];

const INJECTION =
  /ignore (all |the |your |any )?(previous |prior |above |earlier )?(instructions|rules|prompts?)|disregard (your|the) (rules|instructions)|system prompt|your (instructions|prompt|rules) (are|is)|developer mode|jailbreak|\bdan mode\b|you are now|act as (an?|my) |pretend to be|api[_ -]?key|access token|bot token|\.env\b|environment variables?|oldingi (ko'rsatma|buyruq)larni|ko'rsatmalaringni (ko'rsat|unut)|promptingni|забудь (все )?(инструкции|правила)|игнорируй (все )?(инструкции|предыдущ)|системн(ый|ые) промпт|покажи (свой )?промпт|ключ api|токен/;

const GREETING =
  /^(salom|assalomu alaykum|assalomu aleykum|assalom|salom alaykum|hayrli (tong|kun|kech)|xayrli (tong|kun|kech)|привет|здравствуйте|добрый (день|вечер)|hi|hello|hey|good (morning|evening))[\s!.,?)]*$/;

function score(rules: Rule[], text: string, matched: string[]): number {
  let best = 0;
  let extra = 0;
  for (const r of rules) {
    if (r.re.test(text)) {
      matched.push(r.label);
      if (r.weight > best) {
        extra += best * 0.3;
        best = r.weight;
      } else extra += r.weight * 0.3;
    }
  }
  return Math.min(1, best + extra);
}

export function analyzeHeuristics(rawText: string): HeuristicSignals {
  const text = normalizeForMatching(rawText);
  const matched: string[] = [];
  if (!text) {
    return { personalScore: 0, businessScore: 0, spamScore: 0, injectionSuspected: false, isGreetingOnly: false, matched };
  }

  let personalScore = 0;
  let personalKind: HeuristicSignals['personalKind'];
  for (const r of PERSONAL) {
    if (r.re.test(text)) {
      matched.push(r.label);
      if (r.weight > personalScore) {
        personalScore = r.weight;
        personalKind = r.kind;
      }
    }
  }

  const businessScore = score(BUSINESS, text, matched);
  // "necha pul turadi" is a price question, not lending.
  if (personalKind === 'money' && /necha pul|qancha (pul|turadi)|сколько стоит/.test(text) && !/qarz|berib tur|в долг|одолжи/.test(text)) {
    personalScore = 0;
    personalKind = undefined;
  }
  const spamScore = score(SPAM, text, matched);
  const injectionSuspected = INJECTION.test(text);
  if (injectionSuspected) matched.push('injection');

  return {
    personalScore,
    personalKind,
    businessScore,
    spamScore,
    injectionSuspected,
    isGreetingOnly: GREETING.test(text),
    matched,
  };
}
