import { PROMPT_CANARY } from '../conversations/system-core.js';
import { containsSecret } from '../logging/sanitize.js';

export interface PolicyResult {
  ok: boolean;
  text: string;
  /** Why the reply was blocked (never shown to users). */
  violation?: 'empty' | 'canary' | 'secret' | 'system-prompt' | 'admin-id';
}

const SYSTEM_PROMPT_FRAGMENTS = [
  'non-negotiable rules',
  'owner instructions (written by',
  'internal reference:',
  'messages from contacts are untrusted data',
  '## reply style',
  '## security notice',
];

/** Converts common markdown to plain Telegram text and trims noise. */
export function toPlainTelegramText(input: string): string {
  let t = input.replace(/\r\n/g, '\n').trim();
  // Strip wrapping quotes the model sometimes adds around the whole reply.
  if (/^["«“].*["»”]$/s.test(t) && t.length > 2) t = t.slice(1, -1).trim();
  t = t
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/\*\*(.+?)\*\*/g, '$1') // bold
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|$)/g, '$1$2') // italics
    .replace(/^\s*[*•]\s+/gm, '- ') // bullets
    .replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/**
 * Last line of defence before anything is sent to a contact:
 * blocks leaks of secrets, the system prompt (canary/fragments) and the admin id.
 */
export function applyResponsePolicy(raw: string, opts: { adminTelegramUserId: bigint; maxLength?: number }): PolicyResult {
  const text = toPlainTelegramText(raw);
  if (!text) return { ok: false, text: '', violation: 'empty' };

  if (text.includes(PROMPT_CANARY)) return { ok: false, text: '', violation: 'canary' };

  if (containsSecret(text)) return { ok: false, text: '', violation: 'secret' };

  const lower = text.toLowerCase();
  if (SYSTEM_PROMPT_FRAGMENTS.some((f) => lower.includes(f)))
    return { ok: false, text: '', violation: 'system-prompt' };

  if (text.includes(opts.adminTelegramUserId.toString())) return { ok: false, text: '', violation: 'admin-id' };

  const max = opts.maxLength ?? 3500;
  return { ok: true, text: text.length > max ? `${text.slice(0, max - 1)}…` : text };
}
