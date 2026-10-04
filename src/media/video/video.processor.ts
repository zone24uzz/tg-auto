import { readFile } from 'node:fs/promises';
import type { AiRouter } from '../../ai/router/types.js';
import type { VideoFrame } from '../../ai/types.js';
import { childLogger } from '../../logging/logger.js';
import { describeError } from '../../logging/sanitize.js';
import type { SniffedType } from '../../security/files.js';
import type { Settings } from '../../settings/schema.js';
import { MediaProcessingError, MediaTooLargeError, UnsupportedMediaError } from '../errors.js';
import { probeOrRefuse, type MediaToolkit, type SampledFrame, type TranscodedAudio } from '../ffmpeg.js';
import { removeQuietly } from '../fs-utils.js';
import { checkDuration, computeFrameTimestamps, effectiveDurationSec, truncateChars, videoNoteFramePlan } from '../limits.js';
import { MEDIA_ANALYST_SYSTEM, videoAnalysisPrompt } from '../prompts.js';

const log = childLogger('media.video');

export const VIDEO_FRAME_SCALE = 768;
const MAX_DESCRIPTION_CHARS = 4000;

/** Unrecognised content ("unknown") is refused instead of letting ffmpeg auto-probe arbitrary formats. */
const ACCEPTED_SNIFFS: ReadonlySet<SniffedType> = new Set(['video/mp4', 'video/webm', 'image/gif']);

export type VideoKind = 'VIDEO' | 'VIDEO_NOTE' | 'ANIMATION';

export interface VideoProcessorInput {
  path: string;
  sniffed: SniffedType;
  kind: VideoKind;
  /** Telegram-reported values (untrusted hints: limits use the longer of probed and declared duration). */
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
  /** Decrypted caption (untrusted). */
  caption?: string | null;
  messageId?: number;
}

export type VideoProcessorSettings = Pick<
  Settings,
  'maxVideoDurationSec' | 'frameSampleIntervalSec' | 'maxFrames' | 'maxDocumentChars'
> &
  /** When set, the transcribed audio track is also capped at the audio limit. */
  Partial<Pick<Settings, 'maxAudioDurationSec'>>;

export interface VideoAnalysis {
  /** Visual description from the frames (undefined when visual analysis was impossible). */
  description?: string;
  transcript?: string;
  transcriptTruncated: boolean;
  /** True when the clip has audio but transcription failed (non-fatal). */
  transcriptionFailed: boolean;
  durationSec?: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  frameCount: number;
}

const KIND_META: Record<VideoKind, 'video' | 'video_note' | 'animation'> = {
  VIDEO: 'video',
  VIDEO_NOTE: 'video_note',
  ANIMATION: 'animation',
};

/** Video / round video note / animation → transcript (if audio) + visual description from a few frames. */
export async function processVideo(
  deps: { ai: AiRouter; ffmpeg: MediaToolkit },
  input: VideoProcessorInput,
  settings: VideoProcessorSettings,
): Promise<VideoAnalysis> {
  if (!ACCEPTED_SNIFFS.has(input.sniffed)) {
    throw new UnsupportedMediaError(
      `not a supported video (${input.sniffed})`,
      input.sniffed === 'unknown' ? undefined : input.sniffed,
    );
  }

  const probe = await probeOrRefuse(deps.ffmpeg, input.path, 'video', input.sniffed);
  if (!probe.hasVideo) throw new UnsupportedMediaError('file has no video track', 'no video');

  const limitDuration = effectiveDurationSec(probe.durationSec, input.durationSec);
  const durationCheck = checkDuration(limitDuration, settings.maxVideoDurationSec);
  if (!durationCheck.ok) {
    throw new MediaTooLargeError(`video ${durationCheck.reason}`, {
      durationSec: limitDuration,
      limitSec: settings.maxVideoDurationSec,
    });
  }
  // The probed value is the accurate one for frame planning and labels.
  const durationSec = probe.durationSec ?? input.durationSec ?? undefined;
  const width = probe.width ?? input.width ?? undefined;
  const height = probe.height ?? input.height ?? undefined;
  const hasAudio = probe.hasAudio && input.kind !== 'ANIMATION';

  // 1) Audio → transcript (non-fatal). Only a compact transcode cut to the limit is uploaded.
  let transcript: string | undefined;
  let transcriptTruncated = false;
  let transcriptionFailed = false;
  if (hasAudio) {
    let transcoded: TranscodedAudio | null = null;
    try {
      const maxDurationSec = Math.min(settings.maxVideoDurationSec, settings.maxAudioDurationSec ?? Infinity);
      transcoded = await deps.ffmpeg.transcodeAudio(input.path, { maxDurationSec });
      const routed = await deps.ai.transcribe(
        { audio: await readFile(transcoded.path), mimeType: transcoded.mimeType, fileName: `audio.${transcoded.ext}` },
        { messageId: input.messageId },
      );
      const cut = truncateChars(routed.result.text.trim(), settings.maxDocumentChars);
      transcript = cut.text || undefined;
      transcriptTruncated = cut.truncated;
    } catch (error) {
      transcriptionFailed = true;
      log.warn({ err: describeError(error), kind: input.kind }, 'video transcription failed; continuing with frames');
    } finally {
      await removeQuietly(transcoded?.path);
    }
  }

  // 2) Frames → visual description.
  const plan =
    input.kind === 'VIDEO_NOTE'
      ? videoNoteFramePlan(durationSec ?? 0, settings.maxFrames)
      : {
          timestamps: computeFrameTimestamps(durationSec ?? 0, settings.frameSampleIntervalSec, settings.maxFrames),
          scaleWidth: VIDEO_FRAME_SCALE,
        };
  const timestamps = plan.timestamps.slice(0, Math.max(1, settings.maxFrames));

  let sampled: SampledFrame[] = [];
  let description: string | undefined;
  try {
    sampled = await deps.ffmpeg.sampleFrames(input.path, { timestamps, scaleWidth: plan.scaleWidth });
    if (sampled.length === 0 && timestamps.some((t) => t > 0)) {
      // Duration metadata can be wrong; fall back to the very first frame.
      sampled = await deps.ffmpeg.sampleFrames(input.path, { timestamps: [0], scaleWidth: plan.scaleWidth });
    }
    const frames: VideoFrame[] = [];
    for (const f of sampled.slice(0, settings.maxFrames)) {
      frames.push({ data: await readFile(f.path), mimeType: 'image/jpeg', timestampSec: f.timestampSec });
    }
    if (frames.length === 0) {
      if (!transcript) throw new MediaProcessingError('no frames could be extracted from the video');
    } else {
      try {
        const routed = await deps.ai.analyzeVideo(
          {
            frames,
            transcript,
            metadata: { kind: KIND_META[input.kind], durationSec, width, height, hasAudio: probe.hasAudio },
            system: MEDIA_ANALYST_SYSTEM,
            prompt: videoAnalysisPrompt({
              kind: KIND_META[input.kind],
              caption: input.caption,
              frameTimestamps: frames.map((f) => f.timestampSec),
              hasTranscript: Boolean(transcript),
            }),
            maxOutputTokens: 800,
          },
          { messageId: input.messageId },
        );
        description = truncateChars(routed.result.text.trim(), MAX_DESCRIPTION_CHARS).text || undefined;
      } catch (error) {
        // With a transcript the result is still useful; without one the whole item fails.
        if (!transcript) throw error;
        log.warn({ err: describeError(error), kind: input.kind }, 'visual analysis failed; keeping the transcript');
      }
    }
  } finally {
    await removeQuietly(...sampled.map((f) => f.path));
  }

  return {
    description,
    transcript,
    transcriptTruncated,
    transcriptionFailed,
    durationSec,
    width,
    height,
    hasAudio: probe.hasAudio,
    frameCount: Math.min(sampled.length, settings.maxFrames),
  };
}
