import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiRouter, RoutedResult } from '../../src/ai/router/types.js';
import type { GenerateTextResult, TranscribeResult } from '../../src/ai/types.js';
import { processAudio } from '../../src/media/audio/audio.processor.js';
import { MediaTooLargeError } from '../../src/media/errors.js';
import { Ffmpeg, FfmpegError } from '../../src/media/ffmpeg.js';
import { computeFrameTimestamps } from '../../src/media/limits.js';
import { processVideo } from '../../src/media/video/video.processor.js';
import { sniffMime } from '../../src/security/files.js';
import { listFiles, makeTmpDir, removeDir } from './helpers.js';

const ffmpegPath = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH ?? 'ffprobe';
const available = await new Ffmpeg({ ffmpegPath, ffprobePath }).isAvailable();

function routed<T>(result: T): RoutedResult<T> {
  return { result, provider: 'gemini', model: 'm', usedFallback: false, costUsd: 0 };
}

/** Raw ffprobe (no whitelists) for asserting on our own outputs, e.g. JPEG frames. */
function rawProbe(file: string): { width?: number; channels?: number; codec?: string; duration?: number } {
  const res = spawnSync(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { windowsHide: true, timeout: 30_000 },
  );
  const json = JSON.parse(res.stdout.toString('utf8')) as {
    streams?: Array<{ width?: number; channels?: number; codec_name?: string }>;
    format?: { duration?: string };
  };
  const s = json.streams?.[0];
  return { width: s?.width, channels: s?.channels, codec: s?.codec_name, duration: Number(json.format?.duration) };
}

describe.skipIf(!available)('ffmpeg integration', () => {
  let dir: string;
  let work: string;
  let video: string;
  let longAudio: string;
  let ff: Ffmpeg;

  beforeAll(async () => {
    dir = await makeTmpDir('ffmpeg-src-');
    work = await makeTmpDir('ffmpeg-out-');
    video = path.join(dir, 'test.mp4');
    const res = spawnSync(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=3:size=320x240:rate=10',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=3',
        '-shortest',
        '-pix_fmt',
        'yuv420p',
        video,
      ],
      { windowsHide: true, timeout: 60_000 },
    );
    expect(res.status).toBe(0);
    // 10 s of 44.1 kHz stereo PCM WAV (native encoder, available in every ffmpeg build).
    longAudio = path.join(dir, 'long.wav');
    const audioRes = spawnSync(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-ac', '2', longAudio],
      { windowsHide: true, timeout: 60_000 },
    );
    expect(audioRes.status).toBe(0);
    ff = new Ffmpeg({ ffmpegPath, ffprobePath, tmpDir: work });
  }, 90_000);

  afterAll(async () => {
    await removeDir(dir);
    await removeDir(work);
  });

  it('probes duration, size and streams', async () => {
    const probe = await ff.probe(video);
    expect(probe.durationSec).toBeGreaterThan(2.5);
    expect(probe.durationSec).toBeLessThan(3.6);
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(240);
    expect(probe.hasVideo).toBe(true);
    expect(probe.hasAudio).toBe(true);
    expect(probe.codecs.length).toBeGreaterThanOrEqual(2);
  });

  it('samples JPEG frames (no upscaling) and skips timestamps past the end', async () => {
    const timestamps = computeFrameTimestamps(3, 1, 3);
    const frames = await ff.sampleFrames(video, { timestamps: [...timestamps, 30], scaleWidth: 768 });
    expect(frames).toHaveLength(3);
    for (const f of frames) {
      const data = await readFile(f.path);
      expect(sniffMime(data)).toBe('image/jpeg');
      expect(path.dirname(f.path)).toBe(path.resolve(work));
    }
    expect(rawProbe(frames[0]!.path).width).toBe(320);
    for (const f of frames) await removeDir(f.path);
  }, 60_000);

  it('SEC-01: transcodes audio to compact mono OGG/Opus, hard-capped at maxDurationSec', async () => {
    const out = await ff.transcodeAudio(longAudio, { maxDurationSec: 3 });
    expect(out.mimeType).toBe('audio/ogg');
    expect(out.ext).toBe('ogg');
    const data = await readFile(out.path);
    expect(sniffMime(data)).toBe('audio/ogg');
    const info = rawProbe(out.path);
    expect(info.codec).toBe('opus');
    expect(info.channels).toBe(1);
    expect(info.duration).toBeLessThan(3.2); // the source is 10 s long
    const probe = await ff.probe(out.path);
    expect(probe.hasAudio).toBe(true);
    expect(probe.hasVideo).toBe(false);
    // Far smaller than the 10 s of 44.1 kHz stereo PCM it came from.
    expect(data.length).toBeLessThan(40_000);
    await removeDir(out.path);
  }, 60_000);

  it('SEC-01: refuses audio whose real length exceeds the limit even when the declared duration is tiny', async () => {
    const ai = { transcribe: vi.fn() } as unknown as AiRouter;
    await expect(
      processAudio(
        { ai, ffmpeg: ff },
        { path: longAudio, sniffed: 'audio/wav', kind: 'VOICE', durationSec: 1 },
        { maxAudioDurationSec: 5, maxDocumentChars: 1000 },
      ),
    ).rejects.toBeInstanceOf(MediaTooLargeError);
    expect(ai.transcribe).not.toHaveBeenCalled();
    expect(await listFiles(work)).toEqual([]);
  }, 60_000);

  it('SEC-11: refuses playlist/script demuxers (HLS, concat) even when they reference local files', async () => {
    const hls = path.join(dir, 'evil.m3u8');
    await writeFile(hls, `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\n${longAudio}\n#EXT-X-ENDLIST\n`);
    await expect(ff.probe(hls)).rejects.toBeInstanceOf(FfmpegError);
    await expect(ff.transcodeAudio(hls, { maxDurationSec: 5 })).rejects.toBeInstanceOf(FfmpegError);

    const concat = path.join(dir, 'evil.ogg');
    await writeFile(concat, `ffconcat version 1.0\nfile '${longAudio.replace(/\\/g, '/')}'\n`);
    await expect(ff.probe(concat)).rejects.toThrow(/whitelist|Invalid/i);
    await expect(ff.transcodeAudio(concat, { maxDurationSec: 5 })).rejects.toBeInstanceOf(FfmpegError);
    expect(await listFiles(work)).toEqual([]);
  }, 60_000);

  it('converts raw PCM to an OGG/Opus voice note', async () => {
    const rate = 24_000;
    const pcm = Buffer.alloc(rate * 2);
    for (let i = 0; i < rate; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
    const ogg = await ff.toOggOpus(pcm, { inputFormat: 'pcm16', sampleRate: rate });
    expect(ogg.subarray(0, 4).toString('latin1')).toBe('OggS');
    expect(await listFiles(work)).toEqual([]);
  }, 60_000);

  it('reports failures with a sanitized, short message', async () => {
    const bogus = path.join(dir, 'missing.mp4');
    await expect(ff.probe(bogus)).rejects.toThrow(/ffprobe exited/);
  });

  it('runs the video processor end-to-end with a fake AI and cleans up', async () => {
    const ai = {
      transcribe: vi.fn(async () =>
        routed<TranscribeResult>({
          text: 'beep',
          usage: { inputTokens: 0, outputTokens: 0 },
          provider: 'gemini',
          model: 'm',
          latencyMs: 1,
        }),
      ),
      analyzeVideo: vi.fn(async () =>
        routed<GenerateTextResult>({
          text: 'A colourful test pattern.',
          usage: { inputTokens: 0, outputTokens: 0 },
          provider: 'gemini',
          model: 'm',
          latencyMs: 1,
        }),
      ),
    } as unknown as AiRouter;
    const r = await processVideo(
      { ai, ffmpeg: ff },
      { path: video, sniffed: 'video/mp4', kind: 'VIDEO', caption: 'look' },
      { maxVideoDurationSec: 60, frameSampleIntervalSec: 0.5, maxFrames: 2, maxDocumentChars: 1000 },
    );
    expect(r.transcript).toBe('beep');
    expect(r.description).toBe('A colourful test pattern.');
    expect(r.frameCount).toBe(2);
    const videoCall = vi.mocked(ai.analyzeVideo).mock.calls[0]![0];
    expect(videoCall.frames).toHaveLength(2);
    expect(videoCall.metadata).toMatchObject({ kind: 'video', width: 320, height: 240, hasAudio: true });
    const upload = vi.mocked(ai.transcribe).mock.calls[0]![0];
    expect(upload.mimeType).toBe('audio/ogg');
    expect(sniffMime(upload.audio)).toBe('audio/ogg');
    expect(await listFiles(work)).toEqual([]);
  }, 90_000);
});
