import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiRouter, RoutedResult } from '../../src/ai/router/types.js';
import { AllProvidersFailedError, type GenerateTextResult, type TranscribeResult } from '../../src/ai/types.js';
import { parseEnv } from '../../src/config/env.js';
import type { Db } from '../../src/database/client.js';
import type { MediaKind, MediaStatus } from '../../src/generated/prisma/client.js';
import {
  FfmpegError,
  type MediaToolkit,
  type ProbeResult,
  type SampleFramesOptions,
  type TranscodeAudioOptions,
} from '../../src/media/ffmpeg.js';
import { MediaService } from '../../src/media/media.service.js';
import type { StorageDriver } from '../../src/media/storage/storage.js';
import type { DownloadOptions, DownloadedFile, FileDownloader } from '../../src/media/telegram-file.js';
import { ContentCipher } from '../../src/security/crypto.js';
import { buildDefaultSettings, type Settings } from '../../src/settings/schema.js';
import { JPEG_BYTES, OGG_BYTES, listFiles, makeTmpDir, removeDir, writeTemp } from './helpers.js';

const MB = 1024 * 1024;
const NOW = new Date('2026-10-04T12:00:00.000Z');

const baseSettings: Settings = buildDefaultSettings(
  parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/test',
    TELEGRAM_BOT_TOKEN: '123456789:AAHfakeTokenForTests_abcdefghijklmnopq',
    ADMIN_TELEGRAM_USER_ID: '1',
  }),
);

interface FakeMediaRow {
  id: number;
  kind: MediaKind;
  telegramFileId: string;
  mimeType: string | null;
  fileName: string | null;
  fileSize: number | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  emoji: string | null;
  status: MediaStatus;
  extractedText: string | null;
  description: string | null;
  storageKey: string | null;
  expiresAt: Date | null;
  error: string | null;
  processedAt: Date | null;
}

function mediaRow(partial: Partial<FakeMediaRow> & Pick<FakeMediaRow, 'id' | 'kind'>): FakeMediaRow {
  return {
    telegramFileId: `file-${partial.id}`,
    mimeType: null,
    fileName: null,
    fileSize: null,
    durationSec: null,
    width: null,
    height: null,
    emoji: null,
    status: 'PENDING',
    extractedText: null,
    description: null,
    storageKey: null,
    expiresAt: null,
    error: null,
    processedAt: null,
    ...partial,
  };
}

function fakeDb(rows: FakeMediaRow[], caption: string | null = null) {
  const message = { id: 7, currentCaption: caption, media: rows };
  const statusHistory: Array<{ id: number; status: unknown }> = [];
  const db = {
    message: { findUnique: vi.fn(async () => message) },
    media: {
      update: vi.fn(async ({ where, data }: { where: { id: number }; data: Partial<FakeMediaRow> }) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('row not found');
        if (data.status) statusHistory.push({ id: where.id, status: data.status });
        Object.assign(row, data);
        return row;
      }),
    },
  };
  return { db: db as unknown as Db, raw: db, statusHistory };
}

function textResult(text: string): GenerateTextResult {
  return { text, usage: { inputTokens: 1, outputTokens: 1 }, provider: 'gemini', model: 'test-model', latencyMs: 1 };
}

function routed<T>(result: T): RoutedResult<T> {
  return { result, provider: 'gemini', model: 'test-model', usedFallback: false, costUsd: 0 };
}

function fakeAi(overrides: Partial<AiRouter> = {}): AiRouter {
  const unused = async (): Promise<never> => {
    throw new Error('not used in this test');
  };
  const transcript: TranscribeResult = {
    text: '  hello there  ',
    usage: { inputTokens: 1, outputTokens: 1 },
    provider: 'gemini',
    model: 'test-model',
    latencyMs: 1,
  };
  return {
    generateReply: vi.fn(unused),
    summarize: vi.fn(unused),
    classify: vi.fn(unused),
    analyzeImage: vi.fn(async () => routed(textResult('A cat sitting on a laptop keyboard.'))),
    transcribe: vi.fn(async () => routed(transcript)),
    analyzeVideo: vi.fn(async () => routed(textResult('A person waves at the camera.'))),
    synthesizeSpeech: vi.fn(unused),
    canTranscribe: vi.fn(async () => true),
    canSynthesizeSpeech: vi.fn(async () => false),
    ...overrides,
  };
}

class FakeDownloader implements FileDownloader {
  readonly calls: Array<{ fileId: string; opts: DownloadOptions }> = [];
  constructor(
    private readonly dir: string,
    private readonly contents: Record<string, Buffer | string>,
  ) {}
  async download(fileId: string, opts: DownloadOptions): Promise<DownloadedFile> {
    this.calls.push({ fileId, opts });
    const data = this.contents[fileId];
    if (data === undefined) throw new Error(`no fake content for ${fileId}`);
    return writeTemp(this.dir, data, opts.ext ?? 'bin');
  }
}

const unusedFfmpeg: MediaToolkit = {
  probe: vi.fn(async () => {
    throw new Error('ffmpeg not expected');
  }),
  transcodeAudio: vi.fn(async () => {
    throw new Error('ffmpeg not expected');
  }),
  sampleFrames: vi.fn(async () => {
    throw new Error('ffmpeg not expected');
  }),
};

/** A minimal MP4 header (sniffed as video/mp4). */
const MP4_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42', 'latin1'), Buffer.alloc(32)]);
/** What the fake transcoder "produces" (distinct from every input, so uploads of original bytes are detectable). */
const TRANSCODED_BYTES = Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.from('compact-mono-opus', 'latin1')]);

/** Fake ffmpeg that writes its "outputs" into `dir` like the real one, so cleanup can be asserted. */
function fakeFfmpeg(dir: string, probe: Partial<ProbeResult> = {}) {
  return {
    probe: vi.fn(
      async (): Promise<ProbeResult> => ({
        durationSec: 45,
        width: 640,
        height: 360,
        hasAudio: true,
        hasVideo: true,
        codecs: ['h264', 'aac'],
        ...probe,
      }),
    ),
    transcodeAudio: vi.fn(async (_input: string, _opts: TranscodeAudioOptions) => ({
      path: (await writeTemp(dir, TRANSCODED_BYTES, 'ogg')).path,
      mimeType: 'audio/ogg',
      ext: 'ogg',
    })),
    sampleFrames: vi.fn(async (_input: string, opts: SampleFramesOptions) =>
      Promise.all(
        opts.timestamps.map(async (t) => ({ path: (await writeTemp(dir, JPEG_BYTES, 'jpg')).path, timestampSec: t })),
      ),
    ),
  } satisfies MediaToolkit;
}

/** Fake ffmpeg for audio-only files (no video stream). */
function fakeAudioFfmpeg(dir: string, probe: Partial<ProbeResult> = {}) {
  return fakeFfmpeg(dir, { width: undefined, height: undefined, hasVideo: false, codecs: ['opus'], ...probe });
}

function fakeStorage(): StorageDriver & { put: ReturnType<typeof vi.fn> } {
  return {
    put: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
    delete: vi.fn(async () => undefined),
  };
}

describe('MediaService', () => {
  let tmpDir: string;
  let cipher: ContentCipher;

  beforeEach(async () => {
    tmpDir = await makeTmpDir('svc-');
    cipher = new ContentCipher(randomBytes(32).toString('base64'));
  });
  afterEach(async () => {
    // Every test must leave the temp dir empty.
    expect(await listFiles(tmpDir)).toEqual([]);
    await removeDir(tmpDir);
  });

  function service(opts: {
    rows: FakeMediaRow[];
    caption?: string | null;
    settings?: Partial<Settings>;
    ai?: AiRouter;
    contents?: Record<string, Buffer | string>;
    cloudBotApi?: boolean;
    storage?: StorageDriver;
    ffmpeg?: MediaToolkit;
  }) {
    const { db, raw, statusHistory } = fakeDb(opts.rows, opts.caption ?? null);
    const downloader = new FakeDownloader(tmpDir, opts.contents ?? {});
    const ai = opts.ai ?? fakeAi();
    const storage = opts.storage ?? fakeStorage();
    const settings = { ...baseSettings, ...opts.settings };
    const svc = new MediaService({
      db,
      settings: { get: async () => settings },
      ai,
      cipher,
      downloader,
      ffmpeg: opts.ffmpeg ?? unusedFfmpeg,
      storage,
      tmpDir,
      cloudBotApi: opts.cloudBotApi ?? true,
      now: () => NOW,
    });
    return { svc, downloader, ai, raw, statusHistory, storage };
  }

  it('returns an empty context for messages without media', async () => {
    const { svc } = service({ rows: [] });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx).toMatchObject({ summaryText: '', statuses: [], images: [], failed: false });
  });

  it('marks disabled analysis types as DISABLED without downloading', async () => {
    const rows = [mediaRow({ id: 1, kind: 'PHOTO', fileSize: 1000 })];
    const { svc, downloader } = service({ rows, settings: { imageAnalysisEnabled: false } });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['DISABLED']);
    expect(ctx.disabled).toBe(true);
    expect(ctx.summaryText).toContain('[Image]');
    expect(rows[0]!.status).toBe('DISABLED');
    expect(downloader.calls).toHaveLength(0);
  });

  it('marks files above the size limit as TOO_LARGE from fileSize alone', async () => {
    const rows = [mediaRow({ id: 1, kind: 'VIDEO', fileSize: 50 * MB, durationSec: 30 })];
    const { svc, downloader } = service({ rows, settings: { maxMediaSizeMb: 20 }, cloudBotApi: false });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['TOO_LARGE']);
    expect(ctx.tooLarge).toBe(true);
    expect(ctx.summaryText).toBe('[Video, 30s] [File too large to analyse]');
    expect(rows[0]!.error).toMatch(/exceeds/);
    expect(downloader.calls).toHaveLength(0);
  });

  it('applies the 20 MB cloud Bot API cap and duration limits before downloading', async () => {
    const rows = [
      mediaRow({ id: 1, kind: 'DOCUMENT', fileName: 'big.pdf', fileSize: 25 * MB }),
      mediaRow({ id: 2, kind: 'VOICE', durationSec: 5000, fileSize: 1000 }),
    ];
    const { svc, downloader } = service({
      rows,
      settings: { maxDocumentSizeMb: 100, maxAudioDurationSec: 600 },
      cloudBotApi: true,
    });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['TOO_LARGE', 'TOO_LARGE']);
    expect(rows[0]!.error).toMatch(/20 MB/);
    expect(downloader.calls).toHaveLength(0);
  });

  it('marks stickers SKIPPED without downloading', async () => {
    const rows = [mediaRow({ id: 1, kind: 'STICKER', emoji: '😀' })];
    const { svc, downloader } = service({ rows });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['SKIPPED']);
    expect(ctx.summaryText).toBe('[Sticker 😀]');
    expect(downloader.calls).toHaveLength(0);
  });

  it('refuses blocked document types as UNSUPPORTED without downloading', async () => {
    const rows = [mediaRow({ id: 1, kind: 'DOCUMENT', fileName: 'setup.exe', fileSize: 1000 })];
    const { svc, downloader } = service({ rows });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['UNSUPPORTED']);
    expect(ctx.unsupported).toBe(true);
    expect(ctx.summaryText).toBe('[Document: setup.exe] [Unsupported file type: exe]');
    expect(downloader.calls).toHaveLength(0);
  });

  it('marks content that is not what it claims as UNSUPPORTED (and deletes the temp file)', async () => {
    const rows = [
      mediaRow({ id: 1, kind: 'PHOTO', fileSize: 10 }),
      mediaRow({ id: 2, kind: 'DOCUMENT', fileName: 'invoice.pdf', mimeType: 'application/pdf', fileSize: 20 }),
    ];
    const { svc, ai } = service({ rows, contents: { 'file-1': 'not an image', 'file-2': 'not a pdf either' } });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['UNSUPPORTED', 'UNSUPPORTED']);
    expect(ctx.summaryText).toContain('[Document: invoice.pdf] [Unsupported file type: pdf]');
    expect(ai.analyzeImage).not.toHaveBeenCalled();
  });

  it('analyses a photo: encrypted description, image attached, caption passed as quoted data', async () => {
    const rows = [mediaRow({ id: 1, kind: 'PHOTO', mimeType: 'image/jpeg', fileSize: JPEG_BYTES.length })];
    const caption = cipher.encrypt('what does this error mean?');
    const { svc, ai, statusHistory, downloader } = service({ rows, caption, contents: { 'file-1': JPEG_BYTES } });
    const ctx = await svc.processMessageMedia(7);

    expect(ctx.statuses).toEqual(['DONE']);
    expect(ctx.summaryText).toBe('[Image] Description: A cat sitting on a laptop keyboard.');
    expect(ctx.images).toHaveLength(1);
    expect(ctx.images[0]!.mimeType).toBe('image/jpeg');
    expect(ctx.failed || ctx.tooLarge || ctx.unsupported || ctx.disabled).toBe(false);

    const row = rows[0]!;
    expect(row.status).toBe('DONE');
    expect(row.description).toMatch(/^enc:v1:/);
    expect(cipher.decrypt(row.description)).toBe('A cat sitting on a laptop keyboard.');
    expect(row.processedAt).toEqual(NOW);
    expect(row.error).toBeNull();
    expect(statusHistory.map((s) => s.status)).toEqual(['PROCESSING', 'DONE']);
    expect(downloader.calls[0]!.opts.maxBytes).toBe(20 * MB);

    const call = vi.mocked(ai.analyzeImage).mock.calls[0]!;
    expect(call[0].prompt).toContain('"what does this error mean?"');
    expect(call[0].system).toMatch(/never identify real people/i);
    expect(call[1]).toEqual({ messageId: 7 });
  });

  it('turns AI failures into FAILED without throwing', async () => {
    const rows = [mediaRow({ id: 1, kind: 'PHOTO', fileSize: JPEG_BYTES.length })];
    const ai = fakeAi({
      analyzeImage: vi.fn(async () => {
        throw new AllProvidersFailedError('VISION', [{ provider: 'gemini', model: 'm', error: 'timeout' }]);
      }),
    });
    const { svc } = service({ rows, ai, contents: { 'file-1': JPEG_BYTES } });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['FAILED']);
    expect(ctx.failed).toBe(true);
    expect(ctx.images).toEqual([]);
    expect(ctx.summaryText).toBe('[Image] [Could not be analysed]');
    expect(rows[0]!.status).toBe('FAILED');
    expect(rows[0]!.error).toContain('AllProvidersFailedError');
  });

  it('transcribes a voice message: always probed, always transcoded (capped), transcript exposed', async () => {
    const rows = [mediaRow({ id: 1, kind: 'VOICE', mimeType: 'audio/ogg', durationSec: 12, fileSize: OGG_BYTES.length })];
    const ffmpeg = fakeAudioFfmpeg(tmpDir, { durationSec: 12 });
    const { svc, ai } = service({ rows, ffmpeg, settings: { maxAudioDurationSec: 600 }, contents: { 'file-1': OGG_BYTES } });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['DONE']);
    expect(ctx.summaryText).toBe('[Voice message, 12s] Transcript: "hello there"');
    expect(ctx.transcript).toBe('hello there');
    expect(cipher.decrypt(rows[0]!.extractedText)).toBe('hello there');
    expect(ffmpeg.probe).toHaveBeenCalledTimes(1);
    expect(ffmpeg.transcodeAudio).toHaveBeenCalledTimes(1);
    expect(ffmpeg.transcodeAudio.mock.calls[0]![1]).toEqual({ maxDurationSec: 600 });
    const call = vi.mocked(ai.transcribe).mock.calls[0]!;
    expect(call[0].mimeType).toBe('audio/ogg');
    expect(call[0].fileName).toBe('voice.ogg');
    // Only the transcoded output is uploaded, never the original bytes.
    expect(call[0].audio.equals(TRANSCODED_BYTES)).toBe(true);
    expect(call[0].audio.equals(OGG_BYTES)).toBe(false);
  });

  it('SEC-01: refuses audio whose probed duration exceeds the limit even when the declared one is tiny', async () => {
    const rows = [mediaRow({ id: 1, kind: 'VOICE', mimeType: 'audio/ogg', durationSec: 5, fileSize: OGG_BYTES.length })];
    const ffmpeg = fakeAudioFfmpeg(tmpDir, { durationSec: 3600 });
    const { svc, ai, downloader } = service({
      rows,
      ffmpeg,
      settings: { maxAudioDurationSec: 600 },
      contents: { 'file-1': OGG_BYTES },
    });
    const ctx = await svc.processMessageMedia(7);
    expect(downloader.calls).toHaveLength(1); // declared 5 s passes the pre-download check
    expect(ctx.statuses).toEqual(['TOO_LARGE']);
    expect(ctx.tooLarge).toBe(true);
    expect(ctx.summaryText).toBe('[Voice message, 5s] [File too large to analyse]');
    expect(rows[0]!.error).toMatch(/3600s exceeds the 600s limit/);
    expect(ffmpeg.transcodeAudio).not.toHaveBeenCalled();
    expect(ai.transcribe).not.toHaveBeenCalled();
  });

  it('SEC-01: refuses audio that cannot be probed instead of trusting the declared duration', async () => {
    const rows = [mediaRow({ id: 1, kind: 'AUDIO', fileName: 'a.mp3', mimeType: 'audio/mpeg', durationSec: 5, fileSize: 64 })];
    const ffmpeg = fakeAudioFfmpeg(tmpDir);
    ffmpeg.probe.mockRejectedValueOnce(new FfmpegError('ffprobe exited with 1: Invalid data', 'EXIT'));
    const mp3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.alloc(61, 3)]);
    const { svc, ai } = service({ rows, ffmpeg, contents: { 'file-1': mp3 } });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['UNSUPPORTED']);
    expect(rows[0]!.error).toMatch(/could not be read/);
    expect(ffmpeg.transcodeAudio).not.toHaveBeenCalled();
    expect(ai.transcribe).not.toHaveBeenCalled();
  });

  it('SEC-01: a probe that times out marks the audio FAILED (never transcribed)', async () => {
    const rows = [mediaRow({ id: 1, kind: 'VOICE', durationSec: 5, fileSize: OGG_BYTES.length })];
    const ffmpeg = fakeAudioFfmpeg(tmpDir);
    ffmpeg.probe.mockRejectedValueOnce(new FfmpegError('ffprobe timed out after 30000 ms', 'TIMEOUT'));
    const { svc, ai } = service({ rows, ffmpeg, contents: { 'file-1': OGG_BYTES } });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['FAILED']);
    expect(ai.transcribe).not.toHaveBeenCalled();
  });

  it('refuses audio files without an audio stream', async () => {
    const rows = [mediaRow({ id: 1, kind: 'VOICE', durationSec: 5, fileSize: OGG_BYTES.length })];
    const ffmpeg = fakeAudioFfmpeg(tmpDir, { hasAudio: false });
    const { svc, ai } = service({ rows, ffmpeg, contents: { 'file-1': OGG_BYTES } });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['UNSUPPORTED']);
    expect(ai.transcribe).not.toHaveBeenCalled();
  });

  it('SEC-11: refuses audio and video of an unrecognised format without running ffmpeg', async () => {
    const rows = [
      mediaRow({ id: 1, kind: 'AUDIO', fileName: 'clip.amr', mimeType: 'audio/amr', durationSec: 5, fileSize: 64 }),
      mediaRow({ id: 2, kind: 'VIDEO', mimeType: 'video/mp4', durationSec: 5, fileSize: 64 }),
    ];
    const ffmpeg = fakeFfmpeg(tmpDir);
    const unknown = Buffer.from('#EXTM3U\n#EXTINF:10,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n', 'latin1');
    const { svc, ai } = service({ rows, ffmpeg, contents: { 'file-1': unknown, 'file-2': unknown } });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['UNSUPPORTED', 'UNSUPPORTED']);
    expect(ctx.summaryText).toContain('[Audio: clip.amr, 5s] [Unsupported file type: amr]');
    expect(ffmpeg.probe).not.toHaveBeenCalled();
    expect(ffmpeg.transcodeAudio).not.toHaveBeenCalled();
    expect(ffmpeg.sampleFrames).not.toHaveBeenCalled();
    expect(ai.transcribe).not.toHaveBeenCalled();
  });

  it('extracts document text', async () => {
    const rows = [mediaRow({ id: 1, kind: 'DOCUMENT', fileName: 'notes.txt', mimeType: 'text/plain', fileSize: 9 })];
    const { svc } = service({ rows, contents: { 'file-1': 'hello doc' } });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['DONE']);
    expect(ctx.summaryText).toBe('[Document: notes.txt] Extracted text: hello doc');
  });

  it('SEC-08: retains raw media encrypted at rest when enabled (and reads it back decrypted)', async () => {
    const rows = [mediaRow({ id: 3, kind: 'PHOTO', mimeType: 'image/jpeg', fileSize: JPEG_BYTES.length })];
    const storage = fakeStorage();
    const { svc } = service({
      rows,
      storage,
      settings: { retainRawMedia: true, mediaRetentionDays: 3 },
      contents: { 'file-3': JPEG_BYTES },
    });
    await svc.processMessageMedia(7);
    expect(storage.put).toHaveBeenCalledTimes(1);
    const [key, data, type] = storage.put.mock.calls[0]! as [string, Buffer, string];
    expect(key).toBe('media/7/3.jpg');
    expect(Buffer.isBuffer(data)).toBe(true);
    expect(data.includes(JPEG_BYTES)).toBe(false);
    expect(ContentCipher.isEncryptedBuffer(data)).toBe(true);
    expect(cipher.decryptBuffer(data).equals(JPEG_BYTES)).toBe(true);
    expect(type).toBe('application/octet-stream');
    expect(rows[0]!.storageKey).toBe('media/7/3.jpg');
    expect(rows[0]!.expiresAt).toEqual(new Date(NOW.getTime() + 3 * 86_400_000));

    vi.mocked(storage.get).mockResolvedValueOnce(data);
    expect((await svc.readRetainedMedia('media/7/3.jpg'))!.equals(JPEG_BYTES)).toBe(true);
  });

  it('retains raw media unchanged when no encryption key is configured', async () => {
    cipher = new ContentCipher(undefined);
    const rows = [mediaRow({ id: 3, kind: 'PHOTO', mimeType: 'image/jpeg', fileSize: JPEG_BYTES.length })];
    const storage = fakeStorage();
    const { svc } = service({
      rows,
      storage,
      settings: { retainRawMedia: true, mediaRetentionDays: 3 },
      contents: { 'file-3': JPEG_BYTES },
    });
    await svc.processMessageMedia(7);
    const [, data, type] = storage.put.mock.calls[0]! as [string, Buffer, string];
    expect(data.equals(JPEG_BYTES)).toBe(true);
    expect(type).toBe('image/jpeg');
  });

  it('reuses results of an earlier successful run (job retry) without downloading', async () => {
    const rows = [
      mediaRow({ id: 1, kind: 'VOICE', durationSec: 4, status: 'DONE', extractedText: cipher.encrypt('cached words') }),
    ];
    const { svc, downloader, ai } = service({ rows });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.summaryText).toBe('[Voice message, 4s] Transcript: "cached words"');
    expect(ctx.transcript).toBe('cached words');
    expect(downloader.calls).toHaveLength(0);
    expect(ai.transcribe).not.toHaveBeenCalled();
  });

  it('analyses a video: probe → transcript → sampled frames → combined description, temp files removed', async () => {
    const rows = [mediaRow({ id: 1, kind: 'VIDEO', mimeType: 'video/mp4', durationSec: 45, fileSize: MP4_BYTES.length })];
    const ffmpeg = fakeFfmpeg(tmpDir, { durationSec: 45 });
    const { svc, ai } = service({
      rows,
      ffmpeg,
      caption: cipher.encrypt('is this normal?'),
      settings: { frameSampleIntervalSec: 5, maxFrames: 6 },
      contents: { 'file-1': MP4_BYTES },
    });
    const ctx = await svc.processMessageMedia(7);

    expect(ctx.statuses).toEqual(['DONE']);
    expect(ctx.summaryText).toBe('[Video, 45s] Transcript: "hello there" Visual: A person waves at the camera.');
    expect(ffmpeg.sampleFrames).toHaveBeenCalledTimes(1);
    const sampleOpts = ffmpeg.sampleFrames.mock.calls[0]![1];
    expect(sampleOpts.timestamps).toHaveLength(6);
    const call = vi.mocked(ai.analyzeVideo).mock.calls[0]![0];
    expect(call.frames).toHaveLength(6);
    expect(call.transcript).toBe('hello there');
    expect(call.metadata).toMatchObject({ kind: 'video', durationSec: 45, hasAudio: true });
    expect(call.prompt).toContain('"is this normal?"');
    const transcribeCall = vi.mocked(ai.transcribe).mock.calls[0]![0];
    expect(transcribeCall.mimeType).toBe('audio/ogg');
    expect(transcribeCall.audio.equals(TRANSCODED_BYTES)).toBe(true);
    // The audio track is capped at the smaller of the video and the audio limits.
    expect(ffmpeg.transcodeAudio.mock.calls[0]![1]).toEqual({
      maxDurationSec: Math.min(baseSettings.maxVideoDurationSec, baseSettings.maxAudioDurationSec),
    });
    expect(cipher.decrypt(rows[0]!.extractedText)).toBe('hello there');
    expect(cipher.decrypt(rows[0]!.description)).toBe('A person waves at the camera.');
    // afterEach asserts that the video, the WAV and every frame were deleted.
  });

  it('samples at most 4 frames at 384 px for a round video note', async () => {
    const rows = [mediaRow({ id: 1, kind: 'VIDEO_NOTE', durationSec: 20, fileSize: MP4_BYTES.length })];
    const ffmpeg = fakeFfmpeg(tmpDir, { durationSec: 20, width: 384, height: 384 });
    const { svc } = service({ rows, ffmpeg, settings: { maxFrames: 10 }, contents: { 'file-1': MP4_BYTES } });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['DONE']);
    expect(ctx.summaryText.startsWith('[Round video note, 20s] Transcript: "hello there"')).toBe(true);
    const opts = ffmpeg.sampleFrames.mock.calls[0]![1];
    expect(opts.timestamps).toHaveLength(4);
    expect(opts.scaleWidth).toBe(384);
  });

  it('keeps the visual description when video transcription fails (non-fatal)', async () => {
    const rows = [mediaRow({ id: 1, kind: 'VIDEO', durationSec: 10, fileSize: MP4_BYTES.length })];
    const ai = fakeAi({
      transcribe: vi.fn(async () => {
        throw new AllProvidersFailedError('TRANSCRIBE', [{ provider: 'gemini', model: 'm', error: 'down' }]);
      }),
    });
    const { svc } = service({ rows, ai, ffmpeg: fakeFfmpeg(tmpDir, { durationSec: 10 }), contents: { 'file-1': MP4_BYTES } });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['DONE']);
    expect(ctx.summaryText).toBe('[Video, 10s] Transcript: (unavailable) Visual: A person waves at the camera.');
  });

  it('marks a video FAILED when visual analysis fails and there is no transcript (frames still deleted)', async () => {
    const rows = [mediaRow({ id: 1, kind: 'ANIMATION', durationSec: 3, fileSize: MP4_BYTES.length })];
    const ai = fakeAi({
      analyzeVideo: vi.fn(async () => {
        throw new AllProvidersFailedError('VIDEO', [{ provider: 'gemini', model: 'm', error: 'down' }]);
      }),
    });
    const ffmpeg = fakeFfmpeg(tmpDir, { durationSec: 3, hasAudio: false });
    const { svc } = service({ rows, ai, ffmpeg, contents: { 'file-1': MP4_BYTES } });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['FAILED']);
    expect(ctx.failed).toBe(true);
    expect(ctx.summaryText).toBe('[GIF/animation, 3s] [Could not be analysed]');
    expect(ffmpeg.transcodeAudio).not.toHaveBeenCalled();
    expect(ffmpeg.sampleFrames).toHaveBeenCalledTimes(1);
  });

  it('refuses videos whose probed duration exceeds the limit (TOO_LARGE after download)', async () => {
    const rows = [mediaRow({ id: 1, kind: 'VIDEO', fileSize: MP4_BYTES.length })];
    const ffmpeg = fakeFfmpeg(tmpDir, { durationSec: 4000 });
    const { svc, ai } = service({ rows, ffmpeg, settings: { maxVideoDurationSec: 180 }, contents: { 'file-1': MP4_BYTES } });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['TOO_LARGE']);
    expect(ctx.tooLarge).toBe(true);
    expect(ffmpeg.sampleFrames).not.toHaveBeenCalled();
    expect(ai.analyzeVideo).not.toHaveBeenCalled();
  });

  it('SEC-01: refuses videos whose probed duration exceeds the limit even when the declared one is short', async () => {
    const rows = [mediaRow({ id: 1, kind: 'VIDEO', durationSec: 10, fileSize: MP4_BYTES.length })];
    const ffmpeg = fakeFfmpeg(tmpDir, { durationSec: 3600 });
    const { svc, ai } = service({ rows, ffmpeg, settings: { maxVideoDurationSec: 180 }, contents: { 'file-1': MP4_BYTES } });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['TOO_LARGE']);
    expect(ffmpeg.transcodeAudio).not.toHaveBeenCalled();
    expect(ai.transcribe).not.toHaveBeenCalled();
    expect(ai.analyzeVideo).not.toHaveBeenCalled();
  });

  it('transcodes every audio format (here ADTS AAC) to compact OGG/Opus before transcription', async () => {
    const rows = [
      mediaRow({ id: 1, kind: 'AUDIO', fileName: 'clip.aac', mimeType: 'audio/aac', durationSec: 30, fileSize: 64 }),
    ];
    const ffmpeg = fakeAudioFfmpeg(tmpDir, { durationSec: 30, codecs: ['aac'] });
    const aac = Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80]), Buffer.alloc(60, 7)]);
    const { svc, ai } = service({ rows, ffmpeg, contents: { 'file-1': aac } });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['DONE']);
    expect(ctx.summaryText).toBe('[Audio: clip.aac, 30s] Transcript: "hello there"');
    expect(ffmpeg.transcodeAudio).toHaveBeenCalledTimes(1);
    const call = vi.mocked(ai.transcribe).mock.calls[0]![0];
    expect(call.mimeType).toBe('audio/ogg');
    expect(call.fileName).toBe('audio.ogg');
  });

  it('maps undecodable audio to UNSUPPORTED (transcode failure) and removes temp files', async () => {
    const rows = [mediaRow({ id: 1, kind: 'VOICE', durationSec: 5, fileSize: OGG_BYTES.length })];
    const ffmpeg = fakeAudioFfmpeg(tmpDir, { durationSec: 5 });
    ffmpeg.transcodeAudio.mockRejectedValueOnce(new FfmpegError('ffmpeg exited with 1', 'EXIT'));
    const { svc, ai } = service({ rows, ffmpeg, contents: { 'file-1': OGG_BYTES } });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['UNSUPPORTED']);
    expect(ai.transcribe).not.toHaveBeenCalled();
  });

  it('treats images sent as files as DISABLED when image analysis is off', async () => {
    const rows = [mediaRow({ id: 1, kind: 'DOCUMENT', fileName: 'screen.png', mimeType: 'image/png', fileSize: 100 })];
    const { svc, downloader } = service({ rows, settings: { imageAnalysisEnabled: false } });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['DISABLED']);
    expect(ctx.disabled).toBe(true);
    expect(downloader.calls).toHaveLength(0);
  });

  it('keeps going after a download error and reports every item in order', async () => {
    const rows = [
      mediaRow({ id: 1, kind: 'PHOTO', fileSize: 10 }),
      mediaRow({ id: 2, kind: 'STICKER', emoji: '🔥' }),
      mediaRow({ id: 3, kind: 'PHOTO', fileSize: JPEG_BYTES.length }),
    ];
    const { svc } = service({ rows, contents: { 'file-3': JPEG_BYTES } });
    const ctx = await svc.processMessageMedia(7);
    expect(ctx.statuses).toEqual(['FAILED', 'SKIPPED', 'DONE']);
    expect(ctx.summaryText.split('\n')).toHaveLength(3);
  });
});
