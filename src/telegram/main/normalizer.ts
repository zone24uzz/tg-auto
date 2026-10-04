import type { Message, MessageOrigin, User } from 'grammy/types';
import type { MessageType } from '../../generated/prisma/client.js';
import type { NormalizedForward, NormalizedMedia, NormalizedMessage, NormalizedSender } from '../../messages/types.js';
import { sanitizeFileName } from '../../security/files.js';

const MAX_TEXT = 8_000;

function clip(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

export function normalizeUser(user: User | undefined): NormalizedSender | null {
  if (!user) return null;
  return {
    telegramUserId: BigInt(user.id),
    username: user.username,
    firstName: user.first_name,
    lastName: user.last_name,
    languageCode: user.language_code,
    isBot: user.is_bot,
  };
}

function normalizeForward(origin: MessageOrigin | undefined): NormalizedForward | undefined {
  if (!origin) return undefined;
  const date = new Date(origin.date * 1000);
  switch (origin.type) {
    case 'user':
      return {
        originType: 'user',
        senderName: [origin.sender_user.first_name, origin.sender_user.last_name].filter(Boolean).join(' '),
        date,
      };
    case 'hidden_user':
      return { originType: 'hidden_user', senderName: origin.sender_user_name, date };
    case 'chat':
      return { originType: 'chat', senderName: origin.sender_chat.title, date };
    case 'channel':
      return { originType: 'channel', senderName: origin.chat.title, date };
    default:
      return { originType: 'unknown', date };
  }
}

/** Extracts media descriptors and the message type. Downloads happen later, in the media worker. */
function extractMedia(m: Message): { type: MessageType; media: NormalizedMedia[]; syntheticText?: string } {
  if (m.photo && m.photo.length > 0) {
    // Telegram sends several sizes; the last one is the largest.
    const largest = m.photo[m.photo.length - 1]!;
    return {
      type: 'PHOTO',
      media: [
        {
          kind: 'PHOTO',
          fileId: largest.file_id,
          fileUniqueId: largest.file_unique_id,
          mimeType: 'image/jpeg',
          fileSize: largest.file_size,
          width: largest.width,
          height: largest.height,
        },
      ],
    };
  }
  if (m.voice) {
    return {
      type: 'VOICE',
      media: [
        {
          kind: 'VOICE',
          fileId: m.voice.file_id,
          fileUniqueId: m.voice.file_unique_id,
          mimeType: m.voice.mime_type ?? 'audio/ogg',
          fileSize: m.voice.file_size,
          durationSec: m.voice.duration,
        },
      ],
    };
  }
  if (m.video_note) {
    return {
      type: 'VIDEO_NOTE',
      media: [
        {
          kind: 'VIDEO_NOTE',
          fileId: m.video_note.file_id,
          fileUniqueId: m.video_note.file_unique_id,
          mimeType: 'video/mp4',
          fileSize: m.video_note.file_size,
          durationSec: m.video_note.duration,
          width: m.video_note.length,
          height: m.video_note.length,
        },
      ],
    };
  }
  if (m.animation) {
    return {
      type: 'ANIMATION',
      media: [
        {
          kind: 'ANIMATION',
          fileId: m.animation.file_id,
          fileUniqueId: m.animation.file_unique_id,
          mimeType: m.animation.mime_type ?? 'video/mp4',
          fileName: sanitizeFileName(m.animation.file_name),
          fileSize: m.animation.file_size,
          durationSec: m.animation.duration,
          width: m.animation.width,
          height: m.animation.height,
        },
      ],
    };
  }
  if (m.video) {
    return {
      type: 'VIDEO',
      media: [
        {
          kind: 'VIDEO',
          fileId: m.video.file_id,
          fileUniqueId: m.video.file_unique_id,
          mimeType: m.video.mime_type ?? 'video/mp4',
          fileName: sanitizeFileName(m.video.file_name),
          fileSize: m.video.file_size,
          durationSec: m.video.duration,
          width: m.video.width,
          height: m.video.height,
        },
      ],
    };
  }
  if (m.audio) {
    return {
      type: 'AUDIO',
      media: [
        {
          kind: 'AUDIO',
          fileId: m.audio.file_id,
          fileUniqueId: m.audio.file_unique_id,
          mimeType: m.audio.mime_type,
          fileName: sanitizeFileName(m.audio.file_name),
          fileSize: m.audio.file_size,
          durationSec: m.audio.duration,
        },
      ],
    };
  }
  if (m.document) {
    return {
      type: 'DOCUMENT',
      media: [
        {
          kind: 'DOCUMENT',
          fileId: m.document.file_id,
          fileUniqueId: m.document.file_unique_id,
          mimeType: m.document.mime_type,
          fileName: sanitizeFileName(m.document.file_name),
          fileSize: m.document.file_size,
        },
      ],
    };
  }
  if (m.sticker) {
    return {
      type: 'STICKER',
      media: [
        {
          kind: 'STICKER',
          fileId: m.sticker.file_id,
          fileUniqueId: m.sticker.file_unique_id,
          fileSize: m.sticker.file_size,
          width: m.sticker.width,
          height: m.sticker.height,
          emoji: m.sticker.emoji,
        },
      ],
      syntheticText: `[sticker${m.sticker.emoji ? ` ${m.sticker.emoji}` : ''}]`,
    };
  }
  if (m.contact) return { type: 'CONTACT', media: [], syntheticText: '[shared a contact]' };
  if (m.location || m.venue) return { type: 'LOCATION', media: [], syntheticText: '[shared a location]' };
  if (m.poll) return { type: 'POLL', media: [], syntheticText: `[poll: ${clip(m.poll.question) ?? ''}]` };
  if (m.text !== undefined) return { type: 'TEXT', media: [] };
  return { type: 'OTHER', media: [], syntheticText: '[unsupported message type]' };
}

/**
 * Converts a Telegram Business message (business_message / edited_business_message)
 * into the internal structure. Returns null for messages without a business connection.
 */
export function normalizeBusinessMessage(m: Message): NormalizedMessage | null {
  if (!m.business_connection_id) return null;
  const { type, media, syntheticText } = extractMedia(m);
  return {
    connectionId: m.business_connection_id,
    telegramMessageId: m.message_id,
    chatId: BigInt(m.chat.id),
    chatType: m.chat.type,
    chatTitle: 'title' in m.chat ? m.chat.title : undefined,
    sender: normalizeUser(m.from),
    type,
    text: clip(m.text) ?? (type === 'TEXT' ? '' : syntheticText),
    caption: clip(m.caption),
    media,
    replyToMessageId: m.reply_to_message?.message_id,
    forward: normalizeForward(m.forward_origin),
    mediaGroupId: m.media_group_id,
    sentByBusinessBot: m.sender_business_bot !== undefined,
    date: new Date(m.date * 1000),
    editDate: m.edit_date ? new Date(m.edit_date * 1000) : undefined,
  };
}
