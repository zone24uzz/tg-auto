import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Api } from 'telegram';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaProcessingError, MediaTooLargeError } from '../../src/media/errors.js';
import { MtprotoDownloader, parseMtprotoFileRef, type DownloadClient } from '../../src/telegram/userbot/downloader.js';
import { PeerResolver } from '../../src/telegram/userbot/peers.js';
import { PEER_ID, big, documentMedia, privateMessage } from './helpers.js';

const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60, 1)]);

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'ub-dl-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function voiceMessage(size = OGG.length): Api.Message {
  return privateMessage({
    id: 12,
    media: documentMedia([new Api.DocumentAttributeAudio({ voice: true, duration: 3 })], { mimeType: 'audio/ogg', size }),
  });
}

function setup(download: DownloadClient['downloadMedia'], message: Api.Message = voiceMessage()) {
  const client: DownloadClient = {
    getInputEntity: vi.fn(async () => new Api.InputPeerUser({ userId: big(PEER_ID), accessHash: big(1) })),
    getMessages: vi.fn(async () => [message]),
    downloadMedia: vi.fn(download),
  };
  const downloader = new MtprotoDownloader(() => client, new PeerResolver(async () => null), tmp);
  return { client, downloader };
}

const ref = `mt:${PEER_ID}:12`;

describe('userbot downloader', () => {
  it('parses mt: references (with an optional index) and rejects garbage', () => {
    expect(parseMtprotoFileRef(ref)).toEqual({ chatId: PEER_ID, messageId: 12 });
    expect(parseMtprotoFileRef(`${ref}:0`)).toEqual({ chatId: PEER_ID, messageId: 12 });
    for (const bad of ['mt:abc', 'mt:1:0', 'mt:1:../2', 'AgADxyz', `mt:${PEER_ID}:12:x`])
      expect(() => parseMtprotoFileRef(bad)).toThrow(MediaProcessingError);
  });

  it('downloads into the temp dir and sniffs the content', async () => {
    const { downloader } = setup(async (_m, params) => {
      params.outputFile.write(OGG);
      params.progressCallback(big(OGG.length));
      params.outputFile.close();
      return params.outputFile.path;
    });
    const file = await downloader.download(ref, { maxBytes: 1024, ext: 'ogg' });
    expect(file.size).toBe(OGG.length);
    expect(file.sniffed).toBe('audio/ogg');
    expect(path.dirname(file.path)).toBe(path.resolve(tmp));
    expect(file.path.endsWith('.ogg')).toBe(true);
    expect(existsSync(file.path)).toBe(true);
  });

  it('refuses a known oversize file without fetching or downloading anything', async () => {
    const { client, downloader } = setup(async () => undefined);
    await expect(downloader.download(ref, { maxBytes: 1000, knownSize: 5000 })).rejects.toBeInstanceOf(MediaTooLargeError);
    expect(client.getMessages).not.toHaveBeenCalled();
    expect(client.downloadMedia).not.toHaveBeenCalled();
  });

  it('re-checks the size reported by Telegram before downloading', async () => {
    const { client, downloader } = setup(async () => undefined, voiceMessage(50 * 1024 * 1024));
    await expect(downloader.download(ref, { maxBytes: 1024 * 1024 })).rejects.toBeInstanceOf(MediaTooLargeError);
    expect(client.downloadMedia).not.toHaveBeenCalled();
  });

  it('aborts when more bytes arrive than allowed and deletes the partial file', async () => {
    const { downloader } = setup(async (_m, params) => {
      params.outputFile.write(Buffer.alloc(64));
      params.progressCallback(big(64)); // throws: over the limit
      return undefined;
    });
    await expect(downloader.download(ref, { maxBytes: 32 })).rejects.toBeInstanceOf(MediaTooLargeError);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('deletes the partial file when the transfer fails', async () => {
    const { downloader } = setup(async (_m, params) => {
      params.outputFile.write(Buffer.alloc(16, 7));
      throw new Error('connection lost');
    });
    const error = await downloader.download(ref, { maxBytes: 1024 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaProcessingError);
    expect((error as Error).message).toContain('connection lost');
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('fails cleanly when the message has no media any more', async () => {
    const { downloader } = setup(async () => undefined, privateMessage({ id: 12, message: 'text only' }));
    await expect(downloader.download(ref, { maxBytes: 1024 })).rejects.toBeInstanceOf(MediaProcessingError);
  });

  it('fails when the userbot is not connected', async () => {
    const downloader = new MtprotoDownloader(() => null, new PeerResolver(async () => null), tmp);
    await expect(downloader.download(ref, { maxBytes: 1024 })).rejects.toThrow(/not connected/);
  });
});
