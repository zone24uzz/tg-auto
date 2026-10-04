import type { MediaKind, MessageType } from '../generated/prisma/client.js';

export interface NormalizedSender {
  telegramUserId: bigint;
  username?: string;
  firstName?: string;
  lastName?: string;
  languageCode?: string;
  isBot: boolean;
  /** MTProto access_hash (userbot transport only). */
  accessHash?: string;
  /** Sender is in the owner's contact list (userbot transport only; the Bot API does not expose this). */
  isContact?: boolean;
}

export interface NormalizedMedia {
  kind: MediaKind;
  fileId: string;
  fileUniqueId: string;
  mimeType?: string;
  /** Display-only; sanitized. Never used as a filesystem path. */
  fileName?: string;
  fileSize?: number;
  durationSec?: number;
  width?: number;
  height?: number;
  emoji?: string;
}

export interface NormalizedForward {
  originType: string;
  senderName?: string;
  date?: Date;
}

/** One internal shape for every incoming Telegram Business message/edit. */
export interface NormalizedMessage {
  connectionId: string;
  telegramMessageId: number;
  chatId: bigint;
  chatType: string;
  chatTitle?: string;
  sender: NormalizedSender | null;
  type: MessageType;
  text?: string;
  caption?: string;
  media: NormalizedMedia[];
  replyToMessageId?: number;
  forward?: NormalizedForward;
  mediaGroupId?: string;
  /** Message was sent by a business bot on behalf of the owner (possibly this bot). */
  sentByBusinessBot: boolean;
  date: Date;
  editDate?: Date;
}

/** Text the AI and classifier see for a message: text/caption plus derived media context. */
export function primaryText(msg: Pick<NormalizedMessage, 'text' | 'caption'>): string {
  return (msg.text ?? msg.caption ?? '').trim();
}
