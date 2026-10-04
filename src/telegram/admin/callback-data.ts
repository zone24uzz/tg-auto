/**
 * Compact callback_data codec shared by notifications and admin menus.
 * Format: "<route>|<arg1>|<arg2>..." — Telegram limits callback_data to 64 bytes.
 * Args must not contain "|". Every handler re-verifies the admin before acting.
 */

export const SEP = '|';

export function cb(route: string, ...args: Array<string | number | bigint>): string {
  const parts = [route, ...args.map((a) => a.toString())];
  for (const p of parts) if (p.includes(SEP)) throw new Error('callback arg contains separator');
  const data = parts.join(SEP);
  if (Buffer.byteLength(data, 'utf8') > 64) throw new Error(`callback_data too long: ${data}`);
  return data;
}

export function parseCb(data: string): { route: string; args: string[] } {
  const [route = '', ...args] = data.split(SEP);
  return { route, args };
}

/** Routes used by notifications created outside the admin UI module. */
export const ROUTES = {
  /** Owner attention: reply manually / let AI reply / ignore / always manual for user / open item */
  attentionReply: 'oa.r',
  attentionAi: 'oa.ai',
  attentionIgnore: 'oa.ig',
  attentionManual: 'oa.mn',
  attentionOpen: 'oa.o',
  /** Message detail view */
  messageOpen: 'msg.o',
  /** Main menu */
  menu: 'm',
} as const;
