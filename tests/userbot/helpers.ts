import { Api, helpers } from 'telegram';
import type { NormalizedSender } from '../../src/messages/types.js';

export const OWNER_ID = 424242n;
export const PEER_ID = 5551234n;
export const CONNECTION_ID = `userbot:${OWNER_ID}`;

export function big(value: bigint | number | string) {
  return helpers.returnBigInt(value);
}

export const ownerSender: NormalizedSender = { telegramUserId: OWNER_ID, username: 'owner', firstName: 'Owner', isBot: false };
export const peerSender: NormalizedSender = { telegramUserId: PEER_ID, username: 'alice', firstName: 'Alice', isBot: false, accessHash: '987', isContact: true };

export interface MessageInit {
  id?: number;
  peer?: Api.TypePeer;
  out?: boolean;
  message?: string;
  media?: Api.TypeMessageMedia;
  fwdFrom?: Api.MessageFwdHeader;
  replyTo?: Api.MessageReplyHeader;
  groupedId?: bigint;
  editDate?: number;
}

/** A GramJS message in a private chat with PEER_ID (no client attached, no network). */
export function privateMessage(init: MessageInit = {}): Api.Message {
  return new Api.Message({
    id: init.id ?? 100,
    peerId: init.peer ?? new Api.PeerUser({ userId: big(PEER_ID) }),
    date: 1_700_000_000,
    message: init.message ?? '',
    out: init.out ?? false,
    media: init.media,
    fwdFrom: init.fwdFrom,
    replyTo: init.replyTo,
    groupedId: init.groupedId !== undefined ? big(init.groupedId) : undefined,
    editDate: init.editDate,
  });
}

export function documentMedia(
  attributes: Api.TypeDocumentAttribute[],
  opts: { id?: bigint; mimeType?: string; size?: number; round?: boolean; voice?: boolean } = {},
): Api.MessageMediaDocument {
  return new Api.MessageMediaDocument({
    document: new Api.Document({
      id: big(opts.id ?? 777n),
      accessHash: big(1),
      fileReference: Buffer.alloc(0),
      date: 0,
      mimeType: opts.mimeType ?? 'application/octet-stream',
      size: big(opts.size ?? 1234),
      dcId: 2,
      attributes,
    }),
    round: opts.round,
    voice: opts.voice,
  });
}

export function photoMedia(id = 4444n): Api.MessageMediaPhoto {
  return new Api.MessageMediaPhoto({
    photo: new Api.Photo({
      id: big(id),
      accessHash: big(1),
      fileReference: Buffer.alloc(0),
      date: 0,
      dcId: 2,
      sizes: [
        new Api.PhotoStrippedSize({ type: 'i', bytes: Buffer.alloc(10) }),
        new Api.PhotoSize({ type: 'm', w: 320, h: 240, size: 9_000 }),
        new Api.PhotoSizeProgressive({ type: 'y', w: 1280, h: 960, sizes: [10_000, 40_000, 95_000] }),
      ],
    }),
  });
}

export function apiUser(id: bigint, extra: { username?: string; firstName?: string; bot?: boolean; contact?: boolean; accessHash?: bigint } = {}) {
  return new Api.User({
    id: big(id),
    username: extra.username,
    firstName: extra.firstName,
    bot: extra.bot,
    contact: extra.contact,
    accessHash: extra.accessHash !== undefined ? big(extra.accessHash) : undefined,
  });
}
