import { GrammyError, InputFile, type Api } from 'grammy';
import { childLogger } from '../../logging/logger.js';
import { describeError } from '../../logging/sanitize.js';

const log = childLogger('sender');

/** Connection ids of the userbot (MTProto) transport start with this prefix: `userbot:<ownerId>`. */
export const USERBOT_CONNECTION_PREFIX = 'userbot:';

export function isUserbotConnection(connectionId: string): boolean {
  return connectionId.startsWith(USERBOT_CONNECTION_PREFIX);
}

export class SendError extends Error {
  constructor(
    message: string,
    /** True when Telegram definitely rejected the request (safe to report as not sent). */
    public readonly definitelyNotSent: boolean,
  ) {
    super(message);
    this.name = 'SendError';
  }
}

/**
 * Sending through the owner's own account (MTProto). Implemented in src/telegram/userbot/transport.ts.
 * Implementations must throw SendError (definitelyNotSent=true only when Telegram answered with an error).
 */
export interface UserbotTransport {
  sendText(chatId: bigint, text: string, replyTo?: number): Promise<number>;
  sendVoice(chatId: bigint, ogg: Buffer, replyTo?: number): Promise<number>;
  typing(chatId: bigint, action: 'typing' | 'record_voice'): Promise<void>;
}

/**
 * Sends messages on behalf of the owner: via the connected Business bot (Bot API, `business_connection_id`)
 * or, for `userbot:` connections, via the owner's own MTProto session.
 */
export class TelegramSender {
  private userbot: UserbotTransport | null = null;

  constructor(private readonly api: Api) {}

  /** Attached at startup when TELEGRAM_TRANSPORT=userbot and the session is authorized. */
  setUserbotTransport(transport: UserbotTransport | null): void {
    this.userbot = transport;
  }

  private requireUserbot(): UserbotTransport {
    if (!this.userbot) throw new SendError('userbot transport is not connected (login required)', true);
    return this.userbot;
  }

  async sendText(p: { connectionId: string; chatId: bigint; text: string; replyTo?: number }): Promise<number> {
    if (isUserbotConnection(p.connectionId)) return this.requireUserbot().sendText(p.chatId, p.text, p.replyTo);
    try {
      const sent = await this.api.sendMessage(Number(p.chatId), p.text, {
        business_connection_id: p.connectionId,
        link_preview_options: { is_disabled: true },
        ...(p.replyTo ? { reply_parameters: { message_id: p.replyTo, allow_sending_without_reply: true } } : {}),
      });
      return sent.message_id;
    } catch (error) {
      throw toSendError(error);
    }
  }

  async sendVoice(p: { connectionId: string; chatId: bigint; ogg: Buffer; replyTo?: number }): Promise<number> {
    if (isUserbotConnection(p.connectionId)) return this.requireUserbot().sendVoice(p.chatId, p.ogg, p.replyTo);
    try {
      const sent = await this.api.sendVoice(Number(p.chatId), new InputFile(p.ogg, 'reply.ogg'), {
        business_connection_id: p.connectionId,
        ...(p.replyTo ? { reply_parameters: { message_id: p.replyTo, allow_sending_without_reply: true } } : {}),
      });
      return sent.message_id;
    } catch (error) {
      throw toSendError(error);
    }
  }

  /** Best-effort typing indicator (shown as the account). */
  async typing(connectionId: string, chatId: bigint, action: 'typing' | 'record_voice' = 'typing'): Promise<void> {
    try {
      if (isUserbotConnection(connectionId)) {
        await this.userbot?.typing(chatId, action);
        return;
      }
      await this.api.sendChatAction(Number(chatId), action, { business_connection_id: connectionId });
    } catch (error) {
      log.debug({ error: describeError(error) }, 'chat action failed');
    }
  }
}

function toSendError(error: unknown): SendError {
  // A GrammyError means Telegram answered with ok=false: the message was not sent.
  if (error instanceof GrammyError) return new SendError(describeError(error), true);
  return new SendError(describeError(error), false);
}
