import type { MediaStatus } from '../generated/prisma/client.js';
import type { ImageInput } from '../ai/types.js';

/** Outcome of processing every media row attached to one message. */
export interface MessageMediaContext {
  /**
   * Text for the classifier and the reply prompt, e.g.
   * "[Voice message, 12s] Transcript: ..." or "[Image] Description: ...".
   * Empty when the message has no media. This is UNTRUSTED content (derived from user media).
   */
  summaryText: string;
  /** Images to attach to the current reply call (photo or a few video frames). Not persisted. */
  images: ImageInput[];
  /** Per-media statuses, in order. */
  statuses: MediaStatus[];
  /** At least one media item exceeded size/duration limits. */
  tooLarge: boolean;
  /** At least one media item has an unsupported format. */
  unsupported: boolean;
  /** At least one media item was skipped because its analysis type is disabled in settings. */
  disabled: boolean;
  /** At least one media item failed to process (download/AI error). */
  failed: boolean;
  /** Voice/audio transcript (joined), if any. Used for adaptive voice replies and history. */
  transcript?: string;
}

/** Contract implemented by src/media/media.service.ts. */
export interface MediaProcessor {
  /**
   * Downloads (to a temp dir), analyses and cleans up every media row of the message,
   * updating the `media` rows (status, extractedText, description, error, processedAt,
   * storageKey/expiresAt when raw retention is on). Never throws for per-item failures.
   */
  processMessageMedia(messageId: number): Promise<MessageMediaContext>;
}
