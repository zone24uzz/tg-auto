/** Escapes text for Telegram parse_mode=HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escapes and truncates untrusted text for display inside admin messages. */
export function quote(text: string | null | undefined, max = 700): string {
  if (!text) return '<i>(bo‘sh)</i>';
  const clipped = text.length > max ? `${text.slice(0, max)}…` : text;
  return escapeHtml(clipped);
}

/** "@username" or "First Last" or "id 123". */
export function displayUser(u: {
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  telegramUserId?: bigint | number | null;
}): string {
  if (u.username) return `@${u.username}`;
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  if (name) return name;
  return u.telegramUserId !== undefined && u.telegramUserId !== null ? `id ${u.telegramUserId.toString()}` : 'noma’lum';
}

/** Telegram hard limit is 4096 chars; keep a safety margin. */
export function clampMessage(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
