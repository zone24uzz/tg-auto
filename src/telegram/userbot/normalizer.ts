import { Api } from 'telegram';
import { MTPROTO_FILE_PREFIX } from '../../app/userbot-contract.js';
import type { MessageType } from '../../generated/prisma/client.js';
import type { NormalizedForward, NormalizedMedia, NormalizedMessage, NormalizedSender } from '../../messages/types.js';
import { sanitizeFileName } from '../../security/files.js';

/**
 * Pure conversion of GramJS (MTProto) messages into the internal NormalizedMessage shape.
 * Mirrors the Bot API normalizer (src/telegram/main/normalizer.ts): same synthetic texts,
 * same text-vs-caption semantics and the same MAX_TEXT clipping.
 */

const MAX_TEXT = 8_000;
/** media.fileSize is a Postgres INT column: larger sizes are clamped (still above any limit). */
const INT32_MAX = 2_147_483_647;

/** Telegram's service notifications account ("Telegram", login codes etc.). */
export const TELEGRAM_SERVICE_USER_ID = 777000n;

function clip(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

/** GramJS `long` values are big-integer objects; constructed objects may also carry number/bigint. */
export function toBigIntId(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : undefined;
  if (typeof value === 'string' || (typeof value === 'object' && value !== null)) {
    const text = String(value);
    return /^-?\d{1,20}$/.test(text) ? BigInt(text) : undefined;
  }
  return undefined;
}

function toSize(value: unknown): number | undefined {
  const big = toBigIntId(value);
  if (big === undefined || big < 0n) return undefined;
  return big > BigInt(INT32_MAX) ? INT32_MAX : Number(big);
}

function toSeconds(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

/** Chat id of a private chat with a user (= the other user's id), or null for groups/channels. */
export function privateChatIdOf(m: { peerId?: unknown }): bigint | null {
  return m.peerId instanceof Api.PeerUser ? (toBigIntId(m.peerId.userId) ?? null) : null;
}

/** `mt:<chatId>:<messageId>` — resolved later by the userbot downloader. */
export function mtprotoFileId(chatId: bigint, messageId: number): string {
  return `${MTPROTO_FILE_PREFIX}${chatId}:${messageId}`;
}

export function normalizeMtprotoUser(user: Api.User): NormalizedSender | null {
  const id = toBigIntId(user.id);
  if (id === undefined) return null;
  const username = user.username ?? user.usernames?.find((u) => u instanceof Api.Username && u.active)?.username;
  // "min" users carry an access_hash that cannot be used to address them, and partial flags.
  const full = user.min !== true;
  return {
    telegramUserId: id,
    username,
    firstName: user.firstName,
    lastName: user.lastName,
    languageCode: user.langCode,
    isBot: user.bot === true,
    accessHash: full && user.accessHash !== undefined ? String(user.accessHash) : undefined,
    isContact: full ? user.contact === true : undefined,
  };
}

interface ExtractedMedia {
  type: MessageType;
  media: NormalizedMedia[];
  syntheticText?: string;
}

const UNSUPPORTED: ExtractedMedia = { type: 'OTHER', media: [], syntheticText: '[unsupported message type]' };

function largestPhotoSize(sizes: Api.TypePhotoSize[]): { w: number; h: number; size?: number } | undefined {
  let best: { w: number; h: number; size?: number } | undefined;
  for (const s of sizes) {
    let candidate: { w: number; h: number; size?: number } | undefined;
    if (s instanceof Api.PhotoSize) candidate = { w: s.w, h: s.h, size: s.size };
    else if (s instanceof Api.PhotoSizeProgressive) candidate = { w: s.w, h: s.h, size: s.sizes.length ? Math.max(...s.sizes) : undefined };
    else if (s instanceof Api.PhotoCachedSize) candidate = { w: s.w, h: s.h, size: s.bytes.length };
    if (candidate && (!best || candidate.w * candidate.h > best.w * best.h)) best = candidate;
  }
  return best;
}

function photoMedia(media: Api.MessageMediaPhoto, fileId: string): ExtractedMedia {
  const photo = media.photo;
  if (!(photo instanceof Api.Photo)) return UNSUPPORTED; // expired self-destructing photo
  const largest = largestPhotoSize(photo.sizes);
  return {
    type: 'PHOTO',
    media: [
      {
        kind: 'PHOTO',
        fileId,
        fileUniqueId: String(photo.id),
        mimeType: 'image/jpeg',
        fileSize: largest?.size,
        width: largest?.w,
        height: largest?.h,
      },
    ],
  };
}

function documentMedia(media: Api.MessageMediaDocument, fileId: string): ExtractedMedia {
  const doc = media.document;
  if (!(doc instanceof Api.Document)) return UNSUPPORTED;
  let audio: Api.DocumentAttributeAudio | undefined;
  let video: Api.DocumentAttributeVideo | undefined;
  let sticker: Api.DocumentAttributeSticker | undefined;
  let image: Api.DocumentAttributeImageSize | undefined;
  let animated = false;
  let rawName: string | undefined;
  for (const a of doc.attributes) {
    if (a instanceof Api.DocumentAttributeAudio) audio = a;
    else if (a instanceof Api.DocumentAttributeVideo) video = a;
    else if (a instanceof Api.DocumentAttributeSticker) sticker = a;
    else if (a instanceof Api.DocumentAttributeImageSize) image = a;
    else if (a instanceof Api.DocumentAttributeAnimated) animated = true;
    else if (a instanceof Api.DocumentAttributeFilename) rawName = a.fileName;
  }
  const base = {
    fileId,
    fileUniqueId: String(doc.id),
    mimeType: doc.mimeType || undefined,
    fileSize: toSize(doc.size),
  };
  const fileName = sanitizeFileName(rawName);

  if (sticker) {
    const emoji = sticker.alt || undefined;
    return {
      type: 'STICKER',
      media: [{ ...base, kind: 'STICKER', width: image?.w ?? video?.w, height: image?.h ?? video?.h, emoji }],
      syntheticText: `[sticker${emoji ? ` ${emoji}` : ''}]`,
    };
  }
  if (audio?.voice || media.voice) {
    return {
      type: 'VOICE',
      media: [{ ...base, kind: 'VOICE', mimeType: base.mimeType ?? 'audio/ogg', durationSec: toSeconds(audio?.duration) }],
    };
  }
  if (video?.roundMessage || media.round) {
    return {
      type: 'VIDEO_NOTE',
      media: [
        { ...base, kind: 'VIDEO_NOTE', mimeType: 'video/mp4', durationSec: toSeconds(video?.duration), width: video?.w, height: video?.h },
      ],
    };
  }
  if (animated) {
    return {
      type: 'ANIMATION',
      media: [
        {
          ...base,
          kind: 'ANIMATION',
          mimeType: base.mimeType ?? 'video/mp4',
          fileName,
          durationSec: toSeconds(video?.duration),
          width: video?.w ?? image?.w,
          height: video?.h ?? image?.h,
        },
      ],
    };
  }
  if (video) {
    return {
      type: 'VIDEO',
      media: [
        { ...base, kind: 'VIDEO', mimeType: base.mimeType ?? 'video/mp4', fileName, durationSec: toSeconds(video.duration), width: video.w, height: video.h },
      ],
    };
  }
  if (audio) {
    return { type: 'AUDIO', media: [{ ...base, kind: 'AUDIO', fileName, durationSec: toSeconds(audio.duration) }] };
  }
  return { type: 'DOCUMENT', media: [{ ...base, kind: 'DOCUMENT', fileName }] };
}

function pollQuestion(poll: Api.TypePoll): string {
  if (!(poll instanceof Api.Poll)) return '';
  const q: unknown = poll.question;
  if (typeof q === 'string') return q;
  return q instanceof Api.TextWithEntities ? q.text : '';
}

/** Message type + media descriptors. Downloads happen later, in the media worker (via `mt:` ids). */
export function extractMtprotoMedia(m: Api.Message, chatId: bigint): ExtractedMedia {
  const media = m.media;
  const fileId = mtprotoFileId(chatId, m.id);
  if (!media || media instanceof Api.MessageMediaEmpty || media instanceof Api.MessageMediaWebPage) {
    return { type: 'TEXT', media: [] }; // a link preview is still a text message
  }
  if (media instanceof Api.MessageMediaPhoto) return photoMedia(media, fileId);
  if (media instanceof Api.MessageMediaDocument) return documentMedia(media, fileId);
  if (media instanceof Api.MessageMediaContact) return { type: 'CONTACT', media: [], syntheticText: '[shared a contact]' };
  if (media instanceof Api.MessageMediaGeo || media instanceof Api.MessageMediaGeoLive || media instanceof Api.MessageMediaVenue)
    return { type: 'LOCATION', media: [], syntheticText: '[shared a location]' };
  if (media instanceof Api.MessageMediaPoll) return { type: 'POLL', media: [], syntheticText: `[poll: ${clip(pollQuestion(media.poll)) ?? ''}]` };
  return UNSUPPORTED;
}

function normalizeForward(f: Api.TypeMessageFwdHeader | undefined, resolvedName: string | undefined): NormalizedForward | undefined {
  if (!(f instanceof Api.MessageFwdHeader)) return undefined;
  const date = new Date(f.date * 1000);
  const name = resolvedName ?? f.fromName ?? f.postAuthor;
  if (f.fromId instanceof Api.PeerUser) return { originType: 'user', senderName: name, date };
  if (f.fromId instanceof Api.PeerChannel) return { originType: f.channelPost !== undefined ? 'channel' : 'chat', senderName: name, date };
  if (f.fromId instanceof Api.PeerChat) return { originType: 'chat', senderName: name, date };
  if (f.fromName) return { originType: 'hidden_user', senderName: f.fromName, date };
  return { originType: 'unknown', date };
}

export interface MtprotoNormalizeContext {
  connectionId: string;
  /** The logged-in account: sender of every outgoing (`out`) message. */
  owner: NormalizedSender;
  /** The other user of the private chat (resolved entity), when known. */
  peer: NormalizedSender | null;
  /** True for messages our own transport sent recently (auto replies → sentByBusinessBot). */
  sentByUs: (chatId: bigint, messageId: number) => boolean;
  /** Display name of the forward origin, resolved from the update's entities (optional). */
  forwardName?: string;
}

/** Converts a private-chat MTProto message. Returns null for anything that is not a chat with a user. */
export function normalizeMtprotoMessage(m: Api.Message, ctx: MtprotoNormalizeContext): NormalizedMessage | null {
  const chatId = privateChatIdOf(m);
  if (chatId === null) return null;
  const outgoing = m.out === true;
  const { type, media, syntheticText } = extractMtprotoMedia(m, chatId);
  const raw = typeof m.message === 'string' ? m.message : '';
  const isText = type === 'TEXT';
  const replyTo = m.replyTo instanceof Api.MessageReplyHeader ? m.replyTo.replyToMsgId : undefined;
  return {
    connectionId: ctx.connectionId,
    telegramMessageId: m.id,
    chatId,
    chatType: 'private',
    sender: outgoing ? ctx.owner : (ctx.peer ?? { telegramUserId: chatId, isBot: false }),
    type,
    // For media messages `message` is the caption (Bot API semantics: text stays empty/synthetic).
    text: isText ? (clip(raw) ?? '') : syntheticText,
    caption: !isText && raw ? clip(raw) : undefined,
    media,
    replyToMessageId: replyTo,
    forward: normalizeForward(m.fwdFrom, ctx.forwardName),
    mediaGroupId: m.groupedId !== undefined && m.groupedId !== null ? String(m.groupedId) : undefined,
    sentByBusinessBot: outgoing && ctx.sentByUs(chatId, m.id),
    date: new Date(m.date * 1000),
    editDate: m.editDate ? new Date(m.editDate * 1000) : undefined,
  };
}
