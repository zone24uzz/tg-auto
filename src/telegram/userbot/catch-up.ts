import { Api } from 'telegram';
import { childLogger } from '../../logging/logger.js';
import { describeError } from '../../logging/sanitize.js';
import { toNormalized, type UserbotEventContext } from './events.js';

const log = childLogger('userbot-catch-up');

/** Only recent messages are answered after an outage; older ones would get a strangely late reply. */
export const CATCH_UP_WINDOW_MS = 30 * 60_000;
const MAX_DIALOGS = 30;
const MAX_PER_CHAT = 10;

/**
 * After (re)connecting, feeds unread incoming private messages from the last 30 minutes into the
 * normal pipeline, so messages that arrived while the client was offline are not lost.
 * Already stored messages are deduplicated by the pipeline (unique Telegram message ids).
 */
export async function catchUpUnread(ctx: UserbotEventContext, now = Date.now()): Promise<number> {
  const since = now - CATCH_UP_WINDOW_MS;
  let fed = 0;
  const dialogs = await ctx.client.getDialogs({ limit: MAX_DIALOGS });
  for (const dialog of dialogs) {
    try {
      if (!dialog.isUser || !dialog.unreadCount) continue;
      const entity = dialog.entity;
      if (!(entity instanceof Api.User) || entity.bot || entity.self) continue;
      const messages = await ctx.client.getMessages(entity, { limit: Math.min(dialog.unreadCount, MAX_PER_CHAT) });
      for (const m of [...messages].reverse()) {
        if (!(m instanceof Api.Message) || m.out || m.date * 1000 < since) continue;
        const msg = await toNormalized(ctx, m);
        if (!msg) continue;
        await ctx.business.handleIncoming(msg);
        fed++;
      }
    } catch (error) {
      log.warn({ error: describeError(error) }, 'catch-up of one chat failed');
    }
  }
  return fed;
}
