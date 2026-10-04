import { readFile } from 'node:fs/promises';
import type { AiRouter } from '../../ai/router/types.js';
import type { SniffedType } from '../../security/files.js';
import type { Settings } from '../../settings/schema.js';
import { MediaTooLargeError, UnsupportedMediaError } from '../errors.js';
import { FfmpegError, probeOrRefuse, type MediaToolkit, type TranscodedAudio } from '../ffmpeg.js';
import { removeQuietly } from '../fs-utils.js';
import { checkDuration, effectiveDurationSec, truncateChars } from '../limits.js';

/**
 * Containers we hand to ffmpeg for audio (magic bytes must match one of them). Anything else,
 * including unrecognised content ("unknown"), is refused instead of letting ffmpeg auto-probe it.
 */
const ACCEPTED_SNIFFS: ReadonlySet<SniffedType> = new Set([
  'audio/ogg',
  'audio/mpeg',
  'audio/wav',
  'audio/flac',
  'video/mp4',
  'video/webm',
]);

export interface AudioProcessorInput {
  path: string;
  sniffed: SniffedType;
  kind: 'VOICE' | 'AUDIO';
  /** Telegram-reported MIME type (untrusted hint). */
  mimeType?: string | null;
  /** Display name (untrusted hint). */
  fileName?: string | null;
  /** Telegram-reported duration (sender-declared, untrusted: the probed duration is always checked too). */
  durationSec?: number | null;
  messageId?: number;
}

export type AudioProcessorSettings = Pick<Settings, 'maxAudioDurationSec' | 'maxDocumentChars'>;

export interface AudioTranscription {
  transcript: string;
  truncated: boolean;
  durationSec?: number;
  language?: string;
}

/**
 * Voice messages and audio files → transcript.
 *
 * The downloaded file is always probed (a probe failure refuses the file) and the longer of the
 * probed and the declared duration is checked against the limit. The provider never receives the
 * original bytes: the audio track is always transcoded to compact mono OGG/Opus and cut to
 * `maxAudioDurationSec`, so even a file whose metadata lies cannot be uploaded beyond the limit.
 */
export async function processAudio(
  deps: { ai: AiRouter; ffmpeg: MediaToolkit },
  input: AudioProcessorInput,
  settings: AudioProcessorSettings,
): Promise<AudioTranscription> {
  if (!ACCEPTED_SNIFFS.has(input.sniffed)) {
    throw new UnsupportedMediaError(
      `not a supported audio file (${input.sniffed})`,
      input.sniffed === 'unknown' ? undefined : input.sniffed,
    );
  }

  const probe = await probeOrRefuse(deps.ffmpeg, input.path, 'audio', input.sniffed);
  if (!probe.hasAudio) throw new UnsupportedMediaError('file has no audio track', 'no audio');

  const limitDuration = effectiveDurationSec(probe.durationSec, input.durationSec);
  const durationCheck = checkDuration(limitDuration, settings.maxAudioDurationSec);
  if (!durationCheck.ok) {
    throw new MediaTooLargeError(`audio ${durationCheck.reason}`, {
      durationSec: limitDuration,
      limitSec: settings.maxAudioDurationSec,
    });
  }
  const durationSec = probe.durationSec ?? input.durationSec ?? undefined;

  let transcoded: TranscodedAudio | null = null;
  try {
    try {
      transcoded = await deps.ffmpeg.transcodeAudio(input.path, { maxDurationSec: settings.maxAudioDurationSec });
    } catch (error) {
      if (error instanceof FfmpegError && (error.code === 'EXIT' || error.code === 'OUTPUT')) {
        throw new UnsupportedMediaError('audio could not be decoded', input.mimeType ?? input.sniffed);
      }
      throw error;
    }
    const audio = await readFile(transcoded.path);
    const routed = await deps.ai.transcribe(
      {
        audio,
        mimeType: transcoded.mimeType,
        fileName: `${input.kind === 'VOICE' ? 'voice' : 'audio'}.${transcoded.ext}`,
      },
      { messageId: input.messageId },
    );
    const { text, truncated } = truncateChars(routed.result.text.trim(), settings.maxDocumentChars);
    return {
      transcript: text,
      truncated,
      durationSec: durationSec ?? routed.result.durationSec,
      language: routed.result.language,
    };
  } finally {
    await removeQuietly(transcoded?.path);
  }
}
