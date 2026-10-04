import { readFile } from 'node:fs/promises';
import type { ImageInput } from '../../ai/types.js';
import type { AiRouter } from '../../ai/router/types.js';
import type { SniffedType } from '../../security/files.js';
import { UnsupportedMediaError } from '../errors.js';
import { truncateChars } from '../limits.js';
import { MEDIA_ANALYST_SYSTEM, imageAnalysisPrompt } from '../prompts.js';

export const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

/** Images up to this size are handed back so the reply call can attach them. */
export const MAX_ATTACHABLE_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_DESCRIPTION_CHARS = 4000;

export interface ImageProcessorInput {
  path: string;
  sniffed: SniffedType;
  /** Decrypted caption of the message (untrusted). */
  caption?: string | null;
  messageId?: number;
}

export interface ImageAnalysis {
  description: string;
  /** The image itself when ≤ 4 MB (for attaching to the reply call), otherwise null. */
  image: ImageInput | null;
  mimeType: SupportedImageType;
}

export function isSupportedImage(sniffed: SniffedType): sniffed is SupportedImageType {
  return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(sniffed);
}

/** Describes a photo/image with the vision model. Throws UnsupportedMediaError for non-images. */
export async function processImage(deps: { ai: AiRouter }, input: ImageProcessorInput): Promise<ImageAnalysis> {
  if (!isSupportedImage(input.sniffed)) {
    throw new UnsupportedMediaError(`not a supported image (${input.sniffed})`, input.sniffed);
  }
  const data = await readFile(input.path);
  const image: ImageInput = { data, mimeType: input.sniffed };
  const routed = await deps.ai.analyzeImage(
    {
      images: [image],
      system: MEDIA_ANALYST_SYSTEM,
      prompt: imageAnalysisPrompt(input.caption),
      maxOutputTokens: 700,
    },
    { messageId: input.messageId },
  );
  const description = truncateChars(routed.result.text.trim(), MAX_DESCRIPTION_CHARS).text;
  return {
    description: description || '(no description returned)',
    image: data.length <= MAX_ATTACHABLE_IMAGE_BYTES ? image : null,
    mimeType: input.sniffed,
  };
}
