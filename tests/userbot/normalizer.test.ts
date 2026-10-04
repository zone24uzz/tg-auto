import { Api } from 'telegram';
import { describe, expect, it } from 'vitest';
import {
  normalizeMtprotoMessage,
  normalizeMtprotoUser,
  toBigIntId,
  type MtprotoNormalizeContext,
} from '../../src/telegram/userbot/normalizer.js';
import { CONNECTION_ID, PEER_ID, apiUser, big, documentMedia, ownerSender, peerSender, photoMedia, privateMessage } from './helpers.js';

function ctx(overrides: Partial<MtprotoNormalizeContext> = {}): MtprotoNormalizeContext {
  return { connectionId: CONNECTION_ID, owner: ownerSender, peer: peerSender, sentByUs: () => false, ...overrides };
}

describe('userbot normalizer', () => {
  it('normalizes an incoming text message from the peer', () => {
    const msg = normalizeMtprotoMessage(privateMessage({ id: 5, message: 'Salom!' }), ctx())!;
    expect(msg).toMatchObject({
      connectionId: CONNECTION_ID,
      telegramMessageId: 5,
      chatId: PEER_ID,
      chatType: 'private',
      type: 'TEXT',
      text: 'Salom!',
      media: [],
      sentByBusinessBot: false,
    });
    expect(msg.caption).toBeUndefined();
    expect(msg.sender).toEqual(peerSender);
    expect(msg.date).toEqual(new Date(1_700_000_000 * 1000));
  });

  it('clips very long texts like the Bot API normalizer', () => {
    const msg = normalizeMtprotoMessage(privateMessage({ message: 'x'.repeat(9_000) }), ctx())!;
    expect(msg.text).toHaveLength(8_000);
  });

  it('returns null for groups and channels', () => {
    expect(normalizeMtprotoMessage(privateMessage({ peer: new Api.PeerChat({ chatId: big(1) }) }), ctx())).toBeNull();
    expect(normalizeMtprotoMessage(privateMessage({ peer: new Api.PeerChannel({ channelId: big(2) }) }), ctx())).toBeNull();
  });

  it('maps a photo: caption semantics, largest size, mt: file id', () => {
    const msg = normalizeMtprotoMessage(privateMessage({ id: 9, message: 'look', media: photoMedia(4444n) }), ctx())!;
    expect(msg.type).toBe('PHOTO');
    expect(msg.text).toBeUndefined();
    expect(msg.caption).toBe('look');
    expect(msg.media).toEqual([
      { kind: 'PHOTO', fileId: `mt:${PEER_ID}:9`, fileUniqueId: '4444', mimeType: 'image/jpeg', fileSize: 95_000, width: 1280, height: 960 },
    ]);
  });

  it('maps a voice note', () => {
    const media = documentMedia([new Api.DocumentAttributeAudio({ voice: true, duration: 7 })], { mimeType: 'audio/ogg', size: 20_000 });
    const msg = normalizeMtprotoMessage(privateMessage({ media }), ctx())!;
    expect(msg.type).toBe('VOICE');
    expect(msg.media[0]).toMatchObject({ kind: 'VOICE', mimeType: 'audio/ogg', durationSec: 7, fileSize: 20_000, fileUniqueId: '777' });
  });

  it('maps a round video (video note) and rounds its duration', () => {
    const media = documentMedia([new Api.DocumentAttributeVideo({ roundMessage: true, duration: 12.4, w: 384, h: 384 })], {
      mimeType: 'video/mp4',
    });
    const msg = normalizeMtprotoMessage(privateMessage({ media }), ctx())!;
    expect(msg.type).toBe('VIDEO_NOTE');
    expect(msg.media[0]).toMatchObject({ kind: 'VIDEO_NOTE', durationSec: 12, width: 384, height: 384, mimeType: 'video/mp4' });
  });

  it('maps a sticker with its emoji as synthetic text', () => {
    const media = documentMedia(
      [
        new Api.DocumentAttributeSticker({ alt: '😂', stickerset: new Api.InputStickerSetEmpty() }),
        new Api.DocumentAttributeImageSize({ w: 512, h: 512 }),
      ],
      { mimeType: 'image/webp' },
    );
    const msg = normalizeMtprotoMessage(privateMessage({ media }), ctx())!;
    expect(msg.type).toBe('STICKER');
    expect(msg.text).toBe('[sticker 😂]');
    expect(msg.media[0]).toMatchObject({ kind: 'STICKER', emoji: '😂', width: 512, height: 512 });
  });

  it('maps animations, videos and audio files', () => {
    const gif = documentMedia([new Api.DocumentAttributeAnimated(), new Api.DocumentAttributeVideo({ duration: 3, w: 200, h: 100 })]);
    expect(normalizeMtprotoMessage(privateMessage({ media: gif }), ctx())!.type).toBe('ANIMATION');
    const video = documentMedia([new Api.DocumentAttributeVideo({ duration: 61, w: 1920, h: 1080 })], { mimeType: 'video/mp4' });
    expect(normalizeMtprotoMessage(privateMessage({ media: video }), ctx())!.media[0]).toMatchObject({ kind: 'VIDEO', durationSec: 61 });
    const audio = documentMedia([new Api.DocumentAttributeAudio({ duration: 200, title: 'song' })], { mimeType: 'audio/mpeg' });
    expect(normalizeMtprotoMessage(privateMessage({ media: audio }), ctx())!.type).toBe('AUDIO');
  });

  it('sanitizes a traversal-style document file name', () => {
    const media = documentMedia([new Api.DocumentAttributeFilename({ fileName: '../../etc/passwd' })], { mimeType: 'text/plain' });
    const msg = normalizeMtprotoMessage(privateMessage({ media, message: 'see file' }), ctx())!;
    expect(msg.type).toBe('DOCUMENT');
    expect(msg.caption).toBe('see file');
    expect(msg.media[0]!.fileName).toBe('passwd');

    const win = documentMedia([new Api.DocumentAttributeFilename({ fileName: '..\\..\\Windows\\evil<1>.pdf' })]);
    const name = normalizeMtprotoMessage(privateMessage({ media: win }), ctx())!.media[0]!.fileName!;
    expect(name).not.toMatch(/[\\/<>]/);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('clamps huge document sizes to the INT column range', () => {
    const media = documentMedia([], { size: 4 * 1024 ** 3 });
    expect(normalizeMtprotoMessage(privateMessage({ media }), ctx())!.media[0]!.fileSize).toBe(2_147_483_647);
  });

  it('uses synthetic texts for contacts, locations and polls; link previews stay text', () => {
    const contact = new Api.MessageMediaContact({ phoneNumber: '1', firstName: 'B', lastName: '', vcard: '', userId: big(0) });
    expect(normalizeMtprotoMessage(privateMessage({ media: contact }), ctx())).toMatchObject({ type: 'CONTACT', text: '[shared a contact]' });
    const geo = new Api.MessageMediaGeo({ geo: new Api.GeoPointEmpty() });
    expect(normalizeMtprotoMessage(privateMessage({ media: geo }), ctx())).toMatchObject({ type: 'LOCATION', text: '[shared a location]' });
    const poll = new Api.MessageMediaPoll({
      poll: new Api.Poll({ id: big(1), question: new Api.TextWithEntities({ text: 'Qachon?', entities: [] }), answers: [] }),
      results: new Api.PollResults({}),
    });
    expect(normalizeMtprotoMessage(privateMessage({ media: poll }), ctx())).toMatchObject({ type: 'POLL', text: '[poll: Qachon?]' });
    const preview = new Api.MessageMediaWebPage({ webpage: new Api.WebPageEmpty({ id: big(1) }) });
    expect(normalizeMtprotoMessage(privateMessage({ media: preview, message: 'https://x.uz' }), ctx())).toMatchObject({
      type: 'TEXT',
      text: 'https://x.uz',
    });
  });

  it('attributes outgoing messages to the owner', () => {
    const msg = normalizeMtprotoMessage(privateMessage({ out: true, message: 'men yozdim' }), ctx())!;
    expect(msg.sender).toEqual(ownerSender);
    expect(msg.chatId).toBe(PEER_ID);
    expect(msg.sentByBusinessBot).toBe(false);
  });

  it('marks outgoing messages sent by our transport as sentByBusinessBot', () => {
    const sent = new Set([`${PEER_ID}:42`]);
    const sentByUs = (chatId: bigint, id: number) => sent.has(`${chatId}:${id}`);
    expect(normalizeMtprotoMessage(privateMessage({ id: 42, out: true, message: 'auto' }), ctx({ sentByUs }))!.sentByBusinessBot).toBe(true);
    expect(normalizeMtprotoMessage(privateMessage({ id: 43, out: true, message: 'own' }), ctx({ sentByUs }))!.sentByBusinessBot).toBe(false);
    // An incoming message never counts as ours, even with a colliding id.
    expect(normalizeMtprotoMessage(privateMessage({ id: 42, out: false }), ctx({ sentByUs }))!.sentByBusinessBot).toBe(false);
  });

  it('maps forwards, replies, albums and edit dates', () => {
    const hidden = new Api.MessageFwdHeader({ fromName: 'Yashirin', date: 1_600_000_000 });
    const m1 = normalizeMtprotoMessage(privateMessage({ fwdFrom: hidden, message: 'fwd' }), ctx())!;
    expect(m1.forward).toEqual({ originType: 'hidden_user', senderName: 'Yashirin', date: new Date(1_600_000_000 * 1000) });

    const fromUser = new Api.MessageFwdHeader({ fromId: new Api.PeerUser({ userId: big(1) }), date: 1_600_000_000 });
    const m2 = normalizeMtprotoMessage(privateMessage({ fwdFrom: fromUser, message: 'fwd' }), ctx({ forwardName: 'Bob' }))!;
    expect(m2.forward).toMatchObject({ originType: 'user', senderName: 'Bob' });

    const m3 = normalizeMtprotoMessage(
      privateMessage({ replyTo: new Api.MessageReplyHeader({ replyToMsgId: 41 }), groupedId: 99n, editDate: 1_700_000_100, message: 'r' }),
      ctx(),
    )!;
    expect(m3.replyToMessageId).toBe(41);
    expect(m3.mediaGroupId).toBe('99');
    expect(m3.editDate).toEqual(new Date(1_700_000_100 * 1000));
  });

  it('falls back to a minimal sender when the peer entity is unknown', () => {
    const msg = normalizeMtprotoMessage(privateMessage({ message: 'hi' }), ctx({ peer: null }))!;
    expect(msg.sender).toEqual({ telegramUserId: PEER_ID, isBot: false });
  });

  it('normalizes users with access hash and contact flag', () => {
    expect(normalizeMtprotoUser(apiUser(PEER_ID, { username: 'alice', firstName: 'Alice', contact: true, accessHash: 987n }))).toEqual({
      telegramUserId: PEER_ID,
      username: 'alice',
      firstName: 'Alice',
      lastName: undefined,
      languageCode: undefined,
      isBot: false,
      accessHash: '987',
      isContact: true,
    });
    const min = new Api.User({ id: big(1), min: true, accessHash: big(5), contact: true });
    expect(normalizeMtprotoUser(min)).toMatchObject({ accessHash: undefined, isContact: undefined });
    expect(normalizeMtprotoUser(apiUser(2n, { bot: true }))!.isBot).toBe(true);
  });

  it('converts GramJS longs to bigint safely', () => {
    expect(toBigIntId(big('123456789012345678'))).toBe(123456789012345678n);
    expect(toBigIntId(5)).toBe(5n);
    expect(toBigIntId('abc')).toBeUndefined();
    expect(toBigIntId(undefined)).toBeUndefined();
  });
});
