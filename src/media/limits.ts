/** Pure limit helpers for the media pipeline (no I/O). */

export const BYTES_PER_MB = 1024 * 1024;

/** The cloud Bot API (api.telegram.org) only lets bots download files up to 20 MB. */
export const CLOUD_BOT_API_MAX_BYTES = 20 * BYTES_PER_MB;

/** Video notes are at most 60 s long and 384×384 px. */
export const VIDEO_NOTE_MAX_FRAMES = 4;
export const VIDEO_NOTE_SCALE = 384;
export const VIDEO_NOTE_MAX_DURATION_SEC = 60;

export type LimitCheck = { ok: true } | { ok: false; reason: string };

export function bytesFromMb(mb: number): number {
  if (!Number.isFinite(mb) || mb <= 0) return 0;
  return Math.floor(mb * BYTES_PER_MB);
}

/** Unknown sizes pass (the downloader still enforces the limit while streaming). */
export function checkSize(sizeBytes: number | null | undefined, maxMb: number): LimitCheck {
  if (sizeBytes === null || sizeBytes === undefined || !Number.isFinite(sizeBytes)) return { ok: true };
  const max = bytesFromMb(maxMb);
  if (sizeBytes > max) {
    return { ok: false, reason: `size ${formatMb(sizeBytes)} MB exceeds the ${formatMb(max)} MB limit` };
  }
  return { ok: true };
}

/** Unknown durations pass (callers probe the file when Telegram did not provide one). */
export function checkDuration(sec: number | null | undefined, maxSec: number): LimitCheck {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return { ok: true };
  if (sec > maxSec) return { ok: false, reason: `duration ${Math.round(sec)}s exceeds the ${maxSec}s limit` };
  return { ok: true };
}

/**
 * Duration to check limits against: the LONGEST of the known values (e.g. probed vs. sender-declared),
 * so a sender cannot understate the length. Non-finite / non-positive values are ignored.
 */
export function effectiveDurationSec(...values: Array<number | null | undefined>): number | undefined {
  const known = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  return known.length > 0 ? Math.max(...known) : undefined;
}

/**
 * Timestamps (seconds) of frames to sample from a clip.
 * - one frame per `intervalSec`, centred in its slot (avoids the black first frame and the end of file);
 * - never more than `maxFrames`: when duration / interval > maxFrames the interval is widened;
 * - never at or beyond `durationSec`;
 * - at least one frame, even for clips shorter than the interval (or of unknown length → [0]).
 */
export function computeFrameTimestamps(durationSec: number, intervalSec: number, maxFrames: number): number[] {
  const cap = Math.max(1, Math.floor(Number.isFinite(maxFrames) ? maxFrames : 1));
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [0];
  const interval = Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec : durationSec;
  const count = Math.min(cap, Math.max(1, Math.floor(durationSec / interval)));
  const slot = durationSec / count;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = Math.round((i + 0.5) * slot * 1000) / 1000;
    out.push(Math.min(t, Math.max(0, durationSec - 0.001)));
  }
  return out;
}

export interface FramePlan {
  timestamps: number[];
  scaleWidth: number;
}

/** Video notes (round videos): ≤ 60 s, 384×384 → at most 4 frames at native size. */
export function videoNoteFramePlan(durationSec: number, maxFrames = VIDEO_NOTE_MAX_FRAMES): FramePlan {
  const duration = Number.isFinite(durationSec) ? Math.min(Math.max(durationSec, 0), VIDEO_NOTE_MAX_DURATION_SEC) : 0;
  const cap = Math.max(1, Math.min(VIDEO_NOTE_MAX_FRAMES, Math.floor(maxFrames)));
  return { timestamps: computeFrameTimestamps(duration, 5, cap), scaleWidth: VIDEO_NOTE_SCALE };
}

/** Truncates to `maxChars` (on a code point boundary) and reports whether anything was cut. */
export function truncateChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return { text, truncated: false };
  let cut = text.slice(0, limit);
  // Do not leave a lone high surrogate at the end.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { text: cut.trimEnd(), truncated: true };
}

/** "12s", "3m 20s", "1h 2m". */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest ? `${m}m ${rest}s` : `${m}m`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

function formatMb(bytes: number): string {
  return (bytes / BYTES_PER_MB).toFixed(1);
}
