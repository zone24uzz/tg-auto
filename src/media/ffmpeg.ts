import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdir, stat, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { sanitizeText } from '../logging/sanitize.js';
import { safeTempPath } from '../security/files.js';
import { MediaProcessingError, UnsupportedMediaError } from './errors.js';
import { removeQuietly } from './fs-utils.js';

const STDERR_TAIL_BYTES = 4096;
const ERROR_STDERR_CHARS = 400;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
/** stderr of a run that produced no output at all (treated like an empty output file, not a crash). */
const NO_OUTPUT_STDERR = /Nothing was written into output file|Output file is empty|received no packets/i;

/**
 * Inputs may only be opened through the `file` protocol: no http/tcp/udp/data/subfile/concat/pipe…,
 * so a crafted container or playlist cannot make ffmpeg fetch URLs or splice in other files.
 */
export const INPUT_PROTOCOL_WHITELIST = 'file';
/**
 * Demuxers allowed for user media (one per accepted sniffed type). Playlist / script / sequence demuxers
 * (hls, dash, concat, image2, ffmetadata…) are excluded, so ffmpeg never auto-probes arbitrary formats.
 * Matched against every alias of a demuxer name, e.g. "mov" covers "mov,mp4,m4a,3gp,3g2,mj2".
 */
export const MEDIA_DEMUXER_WHITELIST = 'mov,matroska,ogg,mp3,wav,flac,aac,gif';
/** Demuxers allowed when converting text-to-speech output (raw PCM or common audio containers). */
export const TTS_DEMUXER_WHITELIST = 's16le,ogg,mp3,wav,flac,aac,mov,matroska';

/** Compact speech format every transcription upload uses: OGG/Opus, mono, 16 kHz, 24 kbit/s (~3 KB/s). */
export const TRANSCODED_AUDIO = { mimeType: 'audio/ogg', ext: 'ogg', sampleRate: 16_000, bitrate: '24k' } as const;

/** Input options that confine an ffmpeg/ffprobe input to a local file of an allowed container format. */
export function inputGuardArgs(formats: string = MEDIA_DEMUXER_WHITELIST): string[] {
  return ['-protocol_whitelist', INPUT_PROTOCOL_WHITELIST, '-format_whitelist', formats];
}

export interface ProbeResult {
  durationSec?: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  hasVideo: boolean;
  videoCodec?: string;
  audioCodec?: string;
  formatName?: string;
  /** All stream codec names, in stream order. */
  codecs: string[];
}

export interface SampledFrame {
  path: string;
  timestampSec: number;
}

export interface SampleFramesOptions {
  timestamps: number[];
  /** Frames are scaled down so the longer side is at most this many pixels (never upscaled). */
  scaleWidth: number;
}

export interface ToOggOpusOptions {
  /** Raw PCM input (signed 16-bit little-endian, mono). Omit for containers ffmpeg can detect (mp3, wav…). */
  inputFormat?: 'pcm16';
  /** Sample rate of raw PCM input (default 24000). */
  sampleRate?: number;
  /** Opus bitrate (default 32k). */
  bitrate?: string;
}

export interface TranscodeAudioOptions {
  /** Hard cap on the output length (ffmpeg `-t`): longer content can never reach the provider. */
  maxDurationSec: number;
}

export interface TranscodedAudio {
  /** Temp file owned by the caller (delete it). */
  path: string;
  mimeType: string;
  ext: string;
}

/** The subset of Ffmpeg the processors use (lets tests pass fakes). */
export interface MediaToolkit {
  probe(file: string): Promise<ProbeResult>;
  /** First audio track → compact mono OGG/Opus, cut to `maxDurationSec`. Never returns the original bytes. */
  transcodeAudio(input: string, opts: TranscodeAudioOptions): Promise<TranscodedAudio>;
  sampleFrames(input: string, opts: SampleFramesOptions): Promise<SampledFrame[]>;
}

/** Runs a binary with an argument array (tests inject a fake). */
export type ExecFn = (cmd: string, args: string[], timeoutMs: number) => Promise<{ stdout: Buffer; stderr: string }>;

export class FfmpegError extends MediaProcessingError {
  constructor(
    message: string,
    public readonly code: 'NOT_FOUND' | 'TIMEOUT' | 'EXIT' | 'OUTPUT' | 'PARSE',
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

export interface FfmpegOptions {
  ffmpegPath: string;
  ffprobePath: string;
  /** Where outputs are written (random names). Pass env.MEDIA_TMP_DIR; defaults to <os tmp>/tg-ai-media. */
  tmpDir?: string;
  /** Hard timeout per ffmpeg/ffprobe invocation (default 120 s; the process is killed). */
  timeoutMs?: number;
  /** Process runner (tests). Defaults to spawning the binary without a shell. */
  exec?: ExecFn;
}

const ffprobeSchema = z.object({
  streams: z
    .array(
      z.object({
        codec_type: z.string().optional(),
        codec_name: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        duration: z.string().optional(),
        disposition: z.object({ attached_pic: z.number().optional() }).partial().optional(),
      }),
    )
    .default([]),
  format: z
    .object({
      duration: z.string().optional(),
      format_name: z.string().optional(),
    })
    .optional(),
});

/**
 * Thin wrapper around ffmpeg/ffprobe: spawn with an argument array (no shell),
 * hidden window, hard timeout and sanitized, truncated stderr in errors.
 * Input paths must come from safeTempPath; outputs are created with safeTempPath.
 * Every input is opened with a protocol whitelist (`file` only) and a demuxer whitelist.
 */
export class Ffmpeg implements MediaToolkit {
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly tmpDir: string;
  private readonly timeoutMs: number;
  private readonly exec: ExecFn;
  private available: Promise<boolean> | null = null;

  constructor(opts: FfmpegOptions) {
    this.ffmpegPath = opts.ffmpegPath;
    this.ffprobePath = opts.ffprobePath;
    this.tmpDir = path.resolve(opts.tmpDir ?? path.join(os.tmpdir(), 'tg-ai-media'));
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.exec = opts.exec ?? run;
  }

  /** True when both ffmpeg and ffprobe can be executed (cached). */
  isAvailable(): Promise<boolean> {
    if (!this.available) {
      this.available = Promise.all([
        this.exec(this.ffmpegPath, ['-hide_banner', '-version'], 10_000),
        this.exec(this.ffprobePath, ['-hide_banner', '-version'], 10_000),
      ]).then(
        () => true,
        () => false,
      );
    }
    return this.available;
  }

  async probe(file: string): Promise<ProbeResult> {
    const { stdout } = await this.exec(
      this.ffprobePath,
      ['-v', 'error', ...inputGuardArgs(), '-print_format', 'json', '-show_format', '-show_streams', file],
      Math.min(this.timeoutMs, 30_000),
    );
    let json: unknown;
    try {
      json = JSON.parse(stdout.toString('utf8'));
    } catch {
      throw new FfmpegError('ffprobe returned invalid JSON', 'PARSE');
    }
    const parsed = ffprobeSchema.safeParse(json);
    if (!parsed.success) throw new FfmpegError('ffprobe returned an unexpected structure', 'PARSE');
    return toProbeResult(parsed.data);
  }

  /**
   * Transcodes the first audio track to compact mono OGG/Opus (16 kHz, 24 kbit/s), cut to
   * `maxDurationSec` with `-t`, without metadata. Transcription uploads only ever use this output,
   * so content longer than the limit (whatever its metadata claims) cannot reach the provider.
   */
  async transcodeAudio(input: string, opts: TranscodeAudioOptions): Promise<TranscodedAudio> {
    const out = await this.outPath(TRANSCODED_AUDIO.ext);
    try {
      await this.exec(this.ffmpegPath, transcodeAudioArgs(input, out, opts.maxDurationSec), this.timeoutMs);
      await assertNonEmpty(out);
      return { path: out, mimeType: TRANSCODED_AUDIO.mimeType, ext: TRANSCODED_AUDIO.ext };
    } catch (error) {
      await removeQuietly(out);
      throw error;
    }
  }

  /**
   * One JPEG per timestamp (fast input seeking). Timestamps that yield no frame (e.g. past the end)
   * are skipped. On failure every frame created so far is deleted.
   */
  async sampleFrames(input: string, opts: SampleFramesOptions): Promise<SampledFrame[]> {
    const size = Math.max(16, Math.min(4096, Math.floor(opts.scaleWidth)));
    const filter =
      `scale=w='min(${size},iw)':h='min(${size},ih)'` + ':force_original_aspect_ratio=decrease:force_divisible_by=2';
    const frames: SampledFrame[] = [];
    try {
      for (const ts of opts.timestamps) {
        const t = Math.max(0, Number.isFinite(ts) ? ts : 0);
        const out = await this.outPath('jpg');
        try {
          await this.exec(
            this.ffmpegPath,
            [
              '-nostdin',
              '-hide_banner',
              '-loglevel',
              'error',
              '-y',
              ...inputGuardArgs(),
              '-ss',
              t.toFixed(3),
              '-i',
              input,
              '-map',
              '0:v:0',
              '-frames:v',
              '1',
              '-vf',
              filter,
              '-c:v',
              'mjpeg',
              '-q:v',
              '4',
              '-f',
              'image2',
              out,
            ],
            Math.min(this.timeoutMs, 60_000),
          );
          await assertNonEmpty(out);
          frames.push({ path: out, timestampSec: t });
        } catch (error) {
          await removeQuietly(out);
          if (error instanceof FfmpegError && error.code === 'OUTPUT') continue;
          throw error;
        }
      }
      return frames;
    } catch (error) {
      await removeQuietly(...frames.map((f) => f.path));
      throw error;
    }
  }

  /**
   * Converts audio (a file path or a Buffer, e.g. TTS output) to an OGG/Opus voice note
   * suitable for sendVoice. Temp files are always removed; the encoded audio is returned.
   */
  async toOggOpus(input: string | Buffer, opts: ToOggOpusOptions = {}): Promise<Buffer> {
    let inputPath: string | null = null;
    let ownInput = false;
    const out = await this.outPath('ogg');
    try {
      if (typeof input === 'string') {
        inputPath = input;
      } else {
        inputPath = await this.outPath(opts.inputFormat === 'pcm16' ? 'pcm' : 'bin');
        ownInput = true;
        await writeFile(inputPath, input, { mode: 0o600 });
      }
      const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...inputGuardArgs(TTS_DEMUXER_WHITELIST)];
      if (opts.inputFormat === 'pcm16') {
        const rate = opts.sampleRate && opts.sampleRate >= 8000 && opts.sampleRate <= 192_000 ? opts.sampleRate : 24_000;
        args.push('-f', 's16le', '-ar', String(Math.round(rate)), '-ac', '1');
      }
      const bitrate = opts.bitrate && /^\d{1,3}k$/.test(opts.bitrate) ? opts.bitrate : '32k';
      args.push(
        '-i',
        inputPath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '48000',
        '-c:a',
        'libopus',
        '-b:a',
        bitrate,
        '-application',
        'voip',
        '-f',
        'ogg',
        out,
      );
      await this.exec(this.ffmpegPath, args, this.timeoutMs);
      await assertNonEmpty(out);
      return await readFile(out);
    } finally {
      await removeQuietly(out, ownInput ? inputPath : null);
    }
  }

  private async outPath(ext: string): Promise<string> {
    await mkdir(this.tmpDir, { recursive: true });
    return safeTempPath(this.tmpDir, ext);
  }
}

/**
 * Probes downloaded user media. A file ffprobe cannot open or parse is refused as UNSUPPORTED
 * (it is never processed on the strength of its Telegram metadata); other failures (missing
 * binary, timeout) propagate and end up as FAILED.
 */
export async function probeOrRefuse(
  toolkit: Pick<MediaToolkit, 'probe'>,
  file: string,
  what: string,
  typeLabel?: string,
): Promise<ProbeResult> {
  try {
    return await toolkit.probe(file);
  } catch (error) {
    if (error instanceof FfmpegError && (error.code === 'EXIT' || error.code === 'PARSE')) {
      throw new UnsupportedMediaError(`${what} could not be read`, typeLabel);
    }
    throw error;
  }
}

/** ffmpeg arguments of {@link Ffmpeg.transcodeAudio} (exported for tests). */
export function transcodeAudioArgs(input: string, out: string, maxDurationSec: number): string[] {
  if (!Number.isFinite(maxDurationSec) || maxDurationSec <= 0) {
    throw new FfmpegError('a positive maximum duration is required to transcode audio', 'EXIT');
  }
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...inputGuardArgs(),
    '-i',
    input,
    '-map',
    '0:a:0',
    '-vn',
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-t',
    String(Math.ceil(maxDurationSec)),
    '-ac',
    '1',
    '-ar',
    String(TRANSCODED_AUDIO.sampleRate),
    '-c:a',
    'libopus',
    '-b:a',
    TRANSCODED_AUDIO.bitrate,
    '-application',
    'voip',
    '-f',
    'ogg',
    out,
  ];
}

function toProbeResult(data: z.infer<typeof ffprobeSchema>): ProbeResult {
  const streams = data.streams;
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const durations = [data.format?.duration, ...streams.map((s) => s.duration)]
    .map((d) => (d === undefined ? NaN : Number(d)))
    .filter((d) => Number.isFinite(d) && d > 0);
  const formatDuration = Number(data.format?.duration);
  const durationSec =
    Number.isFinite(formatDuration) && formatDuration > 0
      ? formatDuration
      : durations.length > 0
        ? Math.max(...durations)
        : undefined;
  return {
    durationSec,
    width: video?.width,
    height: video?.height,
    hasAudio: audio !== undefined,
    hasVideo: video !== undefined,
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    formatName: data.format?.format_name,
    codecs: streams.map((s) => s.codec_name).filter((c): c is string => typeof c === 'string'),
  };
}

async function assertNonEmpty(file: string): Promise<void> {
  try {
    const info = await stat(file);
    if (info.size > 0) return;
  } catch {
    // fall through
  }
  throw new FfmpegError('ffmpeg produced no output', 'OUTPUT');
}

/** Spawns a binary without a shell; kills it on timeout. Never echoes the command line. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const name = path.basename(cmd).replace(/\.exe$/i, '') || 'ffmpeg';
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(cmd, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new FfmpegError(`${name} could not be started: ${sanitizeText(String(error))}`, 'NOT_FOUND'));
      return;
    }
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = Buffer.alloc(0);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new FfmpegError(`${name} timed out after ${timeoutMs} ms`, 'TIMEOUT')));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_STDOUT_BYTES) stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = Buffer.concat([stderrTail, chunk]);
      if (stderrTail.length > STDERR_TAIL_BYTES) stderrTail = stderrTail.subarray(stderrTail.length - STDERR_TAIL_BYTES);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      const code = error.code === 'ENOENT' ? 'NOT_FOUND' : 'EXIT';
      finish(() => reject(new FfmpegError(`${name} failed to start (${error.code ?? 'error'})`, code)));
    });
    child.on('close', (exitCode, signal) => {
      finish(() => {
        if (exitCode === 0) {
          resolve({ stdout: Buffer.concat(stdoutChunks), stderr: stderrTail.toString('utf8') });
          return;
        }
        const rawStderr = stderrTail.toString('utf8');
        const tail = summarizeStderr(rawStderr);
        // Newer ffmpeg versions exit non-zero when an output got no packets (e.g. seeking past the end).
        const code = NO_OUTPUT_STDERR.test(rawStderr) ? 'OUTPUT' : 'EXIT';
        reject(
          new FfmpegError(
            `${name} exited with ${exitCode ?? signal ?? 'unknown status'}${tail ? `: ${tail}` : ''}`,
            code,
          ),
        );
      });
    });
  });
}

function summarizeStderr(stderr: string): string {
  const oneLine = stderr.replace(/\s+/g, ' ').trim();
  const clipped = oneLine.length > ERROR_STDERR_CHARS ? `…${oneLine.slice(-ERROR_STDERR_CHARS)}` : oneLine;
  return sanitizeText(clipped);
}
