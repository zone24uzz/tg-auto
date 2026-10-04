/** Typed errors of the media pipeline. MediaService maps them to `media.status` values. */

/** File size or duration exceeds a configured (or Telegram) limit → status TOO_LARGE. */
export class MediaTooLargeError extends Error {
  constructor(
    message: string,
    public readonly details: { sizeBytes?: number; limitBytes?: number; durationSec?: number; limitSec?: number } = {},
  ) {
    super(message);
    this.name = 'MediaTooLargeError';
  }
}

/** Format is not accepted (wrong magic bytes, macros, executable, mismatch…) → status UNSUPPORTED. */
export class UnsupportedMediaError extends Error {
  constructor(
    message: string,
    /** Short display label of the rejected type, e.g. "exe" or "image/svg+xml". */
    public readonly typeLabel?: string,
  ) {
    super(message);
    this.name = 'UnsupportedMediaError';
  }
}

/** Download / conversion / extraction failure that is not the user's fault → status FAILED. */
export class MediaProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaProcessingError';
  }
}
