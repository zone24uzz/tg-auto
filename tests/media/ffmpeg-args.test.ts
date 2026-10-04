import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Ffmpeg,
  FfmpegError,
  INPUT_PROTOCOL_WHITELIST,
  MEDIA_DEMUXER_WHITELIST,
  TTS_DEMUXER_WHITELIST,
  transcodeAudioArgs,
  type ExecFn,
} from '../../src/media/ffmpeg.js';
import { listFiles, makeTmpDir, removeDir } from './helpers.js';

interface Call {
  cmd: string;
  args: string[];
}

/** Records every invocation; "ffmpeg" writes its output (last argument), "ffprobe" returns JSON. */
function recordingExec(calls: Call[]): ExecFn {
  return async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'ffprobe') {
      const json = { streams: [{ codec_type: 'audio', codec_name: 'opus' }], format: { duration: '3.5', format_name: 'ogg' } };
      return { stdout: Buffer.from(JSON.stringify(json)), stderr: '' };
    }
    await writeFile(args[args.length - 1]!, Buffer.from('out'));
    return { stdout: Buffer.alloc(0), stderr: '' };
  };
}

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Whitelists must be input options, i.e. appear before the input path (`-i` for ffmpeg, the file for ffprobe). */
function expectGuarded(args: string[], input: string, formats: string): void {
  const inputAt = args.indexOf(input);
  expect(inputAt).toBeGreaterThan(0);
  const protoAt = args.indexOf('-protocol_whitelist');
  const formatAt = args.indexOf('-format_whitelist');
  expect(protoAt).toBeGreaterThanOrEqual(0);
  expect(formatAt).toBeGreaterThanOrEqual(0);
  expect(protoAt).toBeLessThan(inputAt);
  expect(formatAt).toBeLessThan(inputAt);
  expect(args[protoAt + 1]).toBe('file');
  expect(args[formatAt + 1]).toBe(formats);
}

describe('ffmpeg invocation hardening (SEC-01 / SEC-11)', () => {
  let dir: string;
  let calls: Call[];
  let ff: Ffmpeg;
  const input = path.join('C:', 'tmp', 'input.bin');

  beforeEach(async () => {
    dir = await makeTmpDir('ffargs-');
    calls = [];
    ff = new Ffmpeg({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', tmpDir: dir, exec: recordingExec(calls) });
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it('only allows the file protocol and media demuxers (no hls/concat/image2/data/http)', () => {
    expect(INPUT_PROTOCOL_WHITELIST).toBe('file');
    for (const banned of ['hls', 'concat', 'image2', 'dash', 'ffmetadata', 'lavfi', 'http']) {
      expect(MEDIA_DEMUXER_WHITELIST.split(',')).not.toContain(banned);
      expect(TTS_DEMUXER_WHITELIST.split(',')).not.toContain(banned);
    }
  });

  it('probe uses both whitelists', async () => {
    const probe = await ff.probe(input);
    expect(probe).toMatchObject({ durationSec: 3.5, hasAudio: true, hasVideo: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('ffprobe');
    expectGuarded(calls[0]!.args, input, MEDIA_DEMUXER_WHITELIST);
  });

  it('transcodeAudio: whitelists, mono compact Opus, metadata stripped and -t hard cap', async () => {
    const out = await ff.transcodeAudio(input, { maxDurationSec: 600 });
    expect(out).toMatchObject({ mimeType: 'audio/ogg', ext: 'ogg' });
    expect(path.dirname(out.path)).toBe(path.resolve(dir));
    const args = calls[0]!.args;
    expectGuarded(args, input, MEDIA_DEMUXER_WHITELIST);
    expect(valueAfter(args, '-t')).toBe('600');
    expect(args.indexOf('-t')).toBeGreaterThan(args.indexOf('-i')); // output option: caps what is written
    expect(valueAfter(args, '-ac')).toBe('1');
    expect(valueAfter(args, '-c:a')).toBe('libopus');
    expect(valueAfter(args, '-map')).toBe('0:a:0');
    expect(valueAfter(args, '-map_metadata')).toBe('-1');
    expect(args).not.toContain('copy');
    expect(args[args.length - 1]).toBe(out.path);
  });

  it('transcodeAudio rounds fractional limits up and refuses a missing/invalid limit', async () => {
    expect(valueAfter(transcodeAudioArgs('in', 'out', 12.2), '-t')).toBe('13');
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => transcodeAudioArgs('in', 'out', bad)).toThrow(FfmpegError);
      await expect(ff.transcodeAudio(input, { maxDurationSec: bad })).rejects.toBeInstanceOf(FfmpegError);
    }
    expect(await listFiles(dir)).toEqual([]);
  });

  it('sampleFrames guards every per-frame invocation', async () => {
    const frames = await ff.sampleFrames(input, { timestamps: [0, 1.5], scaleWidth: 768 });
    expect(frames).toHaveLength(2);
    expect(calls).toHaveLength(2);
    for (const c of calls) expectGuarded(c.args, input, MEDIA_DEMUXER_WHITELIST);
  });

  it('toOggOpus guards raw-PCM and container inputs with the TTS demuxer list', async () => {
    await ff.toOggOpus(Buffer.from([1, 2, 3, 4]), { inputFormat: 'pcm16', sampleRate: 24_000 });
    await ff.toOggOpus(Buffer.from('ID3fake-mp3'));
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      const inputPath = valueAfter(c.args, '-i')!;
      expectGuarded(c.args, inputPath, TTS_DEMUXER_WHITELIST);
    }
    expect(valueAfter(calls[0]!.args, '-f')).toBe('s16le');
    expect(await listFiles(dir)).toEqual([]);
  });

  it('a failed transcode leaves no temp file behind', async () => {
    const failing = new Ffmpeg({
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      tmpDir: dir,
      exec: async () => {
        throw new FfmpegError('ffmpeg exited with 1', 'EXIT');
      },
    });
    await expect(failing.transcodeAudio(input, { maxDurationSec: 30 })).rejects.toBeInstanceOf(FfmpegError);
    expect(await listFiles(dir)).toEqual([]);
  });
});
