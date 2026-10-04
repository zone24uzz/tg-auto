/**
 * Secret scrubbing for anything that may reach logs, the database event log,
 * the admin bot or (never) a Telegram user.
 */

const PATTERNS: Array<[RegExp, string]> = [
  // Telegram bot tokens, including inside /bot<token>/ and /file/bot<token>/ URLs
  [/(?<![0-9])\d{5,}:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/g, '[TELEGRAM_TOKEN]'],
  // Google API keys (classic and AQ.-prefixed)
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[GOOGLE_KEY]'],
  [/\bAQ\.[0-9A-Za-z_-]{20,}\b/g, '[GOOGLE_KEY]'],
  // Anthropic / OpenAI style keys
  [/\bsk-ant-[0-9A-Za-z_-]{16,}\b/g, '[ANTHROPIC_KEY]'],
  [/\bsk-[0-9A-Za-z_-]{16,}\b/g, '[OPENAI_KEY]'],
  // Bearer / basic auth headers
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [REDACTED]'],
  [/\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}(?![A-Za-z0-9])/g, 'Basic [REDACTED]'],
  // key=... / token=... query params
  [/([?&](?:key|api_key|apikey|token|access_token|secret|signature|X-Amz-Signature|X-Amz-Credential)=)[^&\s"']+/gi, '$1[REDACTED]'],
  // credentials in URLs: scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@'],
  // AWS access key ids
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[AWS_KEY_ID]'],
];

const extraSecrets = new Set<string>();

/** Register literal secret values (from env) that must never be printed. */
export function registerSecrets(values: Array<string | undefined | null>): void {
  for (const v of values) if (v && v.length >= 8) extraSecrets.add(v);
}

export function sanitizeText(input: string): string {
  let out = input;
  for (const secret of extraSecrets) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** High-confidence secret detection for outgoing replies (no broad heuristics). */
const SECRET_PATTERNS = PATTERNS.slice(0, 5).map(([re]) => new RegExp(re.source, re.flags.replace('g', '')));

export function containsSecret(text: string): boolean {
  for (const secret of extraSecrets) if (text.includes(secret)) return true;
  return SECRET_PATTERNS.some((re) => re.test(text)) || /\b(AKIA|ASIA)[0-9A-Z]{16}\b/.test(text);
}

/** Safe, short description of any thrown value. Never includes stack traces for users. */
export function describeError(error: unknown, maxLength = 500): string {
  let text: string;
  if (error instanceof Error) text = `${error.name}: ${error.message}`;
  else if (typeof error === 'string') text = error;
  else {
    try {
      text = JSON.stringify(error);
    } catch {
      text = String(error);
    }
  }
  text = sanitizeText(text);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
