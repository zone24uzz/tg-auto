import { readFile } from 'node:fs/promises';
import type { ImageInput } from '../ai/types.js';
import type { AiRouter } from '../ai/router/types.js';
import type { Db } from '../database/client.js';
import type { MediaKind, MediaStatus } from '../generated/prisma/client.js';
import { childLogger } from '../logging/logger.js';
import { describeError } from '../logging/sanitize.js';
import type { ContentCipher } from '../security/crypto.js';
import { extensionOf, type SniffedType } from '../security/files.js';
import type { Settings } from '../settings/schema.js';
import { processAudio } from './audio/audio.processor.js';
import { isAcceptedDocumentExtension } from './documents/detect.js';
import { processDocument } from './documents/document.processor.js';
import { MediaTooLargeError, UnsupportedMediaError } from './errors.js';
import type { MediaToolkit } from './ffmpeg.js';
import { removeQuietly } from './fs-utils.js';
import { isSupportedImage, processImage } from './image/image.processor.js';
import { bytesFromMb, checkDuration, CLOUD_BOT_API_MAX_BYTES, formatDuration } from './limits.js';
import { EncryptedStorage } from './storage/encrypted-storage.js';
import { mediaStorageKey, type StorageDriver } from './storage/storage.js';
import type { DownloadedFile, FileDownloader } from './telegram-file.js';
import type { MediaProcessor, MessageMediaContext } from './types.js';
import { processVideo } from './video/video.processor.js';

const log = childLogger('media');

const DAY_MS = 86_400_000;

export interface MediaServiceDeps {
  db: Db;
  settings: { get(): Promise<Settings> };
  ai: AiRouter;
  cipher: ContentCipher;
  downloader: FileDownloader;
  ffmpeg: MediaToolkit;
  storage: StorageDriver;
  tmpDir: string;
  /** True when files come from api.telegram.org (20 MB download cap). */
  cloudBotApi: boolean;
  /** Clock (tests). */
  now?: () => Date;
}

/** The media columns this service reads. */
interface MediaRow {
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
}

interface MediaUpdate {
  status?: MediaStatus;
  extractedText?: string | null;
  description?: string | null;
  error?: string | null;
  processedAt?: Date | null;
  storageKey?: string | null;
  expiresAt?: Date | null;
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
}

interface ItemOutcome {
  status: MediaStatus;
  summary: string;
  image?: ImageInput;
  transcript?: string;
}

interface ProcessedItem {
  summary: string;
  extractedText?: string;
  description?: string;
  image?: ImageInput;
  transcript?: string;
  durationSec?: number;
  width?: number;
  height?: number;
}

type AnalysableKind = Exclude<MediaKind, 'STICKER'>;

const ENABLED_SETTING: Record<AnalysableKind, keyof Settings> = {
  PHOTO: 'imageAnalysisEnabled',
  VOICE: 'voiceAnalysisEnabled',
  AUDIO: 'audioAnalysisEnabled',
  VIDEO: 'videoAnalysisEnabled',
  VIDEO_NOTE: 'videoNoteAnalysisEnabled',
  ANIMATION: 'videoAnalysisEnabled',
  DOCUMENT: 'documentAnalysisEnabled',
};

/** Extensions we keep for temp/storage names (never executable ones). */
const SAFE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'ogg', 'oga', 'opus', 'mp3', 'm4a', 'wav', 'flac', 'webm', 'mp4', 'mov', 'mkv',
  'pdf', 'docx', 'xlsx', 'csv', 'tsv', 'txt', 'md', 'json', 'log',
]);

const SNIFF_CONTENT_TYPES: Partial<Record<SniffedType, string>> = {
  'image/jpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
  'application/pdf': 'application/pdf',
  'audio/ogg': 'audio/ogg',
  'audio/mpeg': 'audio/mpeg',
  'audio/wav': 'audio/wav',
  'audio/flac': 'audio/flac',
  'video/mp4': 'video/mp4',
  'video/webm': 'video/webm',
};

/**
 * Downloads, analyses and cleans up every media item of a message and builds the
 * (untrusted) media context for the classifier and the reply prompt.
 */
export class MediaService implements MediaProcessor {
  private readonly now: () => Date;
  /** Retained raw media is encrypted at rest (AES-256-GCM) when DATA_ENCRYPTION_KEY is set. */
  private readonly rawStorage: StorageDriver;

  constructor(private readonly deps: MediaServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.rawStorage = new EncryptedStorage(deps.storage, deps.cipher);
  }

  /** Reads (and decrypts) a retained raw media object; null when it does not exist. */
  readRetainedMedia(storageKey: string): Promise<Buffer | null> {
    return this.rawStorage.get(storageKey);
  }

  async processMessageMedia(messageId: number): Promise<MessageMediaContext> {
    const context: MessageMediaContext = {
      summaryText: '',
      images: [],
      statuses: [],
      tooLarge: false,
      unsupported: false,
      disabled: false,
      failed: false,
    };
    const message = await this.deps.db.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        currentCaption: true,
        media: {
          orderBy: { id: 'asc' },
          select: {
            id: true,
            kind: true,
            telegramFileId: true,
            mimeType: true,
            fileName: true,
            fileSize: true,
            durationSec: true,
            width: true,
            height: true,
            emoji: true,
            status: true,
            extractedText: true,
            description: true,
          },
        },
      },
    });
    if (!message || message.media.length === 0) return context;

    const settings = await this.deps.settings.get();
    const caption = this.deps.cipher.decrypt(message.currentCaption);
    const lines: string[] = [];
    const transcripts: string[] = [];

    for (const row of message.media as MediaRow[]) {
      let outcome: ItemOutcome;
      try {
        outcome = await this.processOne(row, settings, caption, messageId);
      } catch (error) {
        // processOne already maps errors; this is a last-resort guard (never throw per item).
        log.error({ err: describeError(error), messageId, mediaId: row.id }, 'unexpected media processing error');
        outcome = { status: 'FAILED', summary: `${labelFor(row)} [Could not be analysed]` };
      }
      context.statuses.push(outcome.status);
      lines.push(outcome.summary);
      if (outcome.status === 'TOO_LARGE') context.tooLarge = true;
      if (outcome.status === 'UNSUPPORTED') context.unsupported = true;
      if (outcome.status === 'DISABLED') context.disabled = true;
      if (outcome.status === 'FAILED') context.failed = true;
      if (outcome.image) context.images.push(outcome.image);
      if (outcome.transcript) transcripts.push(outcome.transcript);
    }

    context.summaryText = lines.join('\n');
    if (transcripts.length > 0) context.transcript = transcripts.join('\n');
    return context;
  }

  private async processOne(
    row: MediaRow,
    settings: Settings,
    caption: string | null,
    messageId: number,
  ): Promise<ItemOutcome> {
    const label = labelFor(row);

    if (row.status === 'DONE') {
      const reused = this.reuseDone(row);
      if (reused) return reused;
    }

    if (row.kind === 'STICKER') {
      await this.update(row.id, { status: 'SKIPPED', processedAt: this.now(), error: null });
      return { status: 'SKIPPED', summary: label };
    }

    if (settings[ENABLED_SETTING[row.kind]] !== true) {
      await this.update(row.id, { status: 'DISABLED', processedAt: this.now(), error: null });
      return { status: 'DISABLED', summary: `${label} [Not analysed: analysis of this media type is turned off]` };
    }

    const maxBytes = this.maxBytesFor(row.kind, settings);
    const tooLargeReason = this.preflightTooLarge(row, settings, maxBytes);
    if (tooLargeReason) {
      await this.update(row.id, { status: 'TOO_LARGE', processedAt: this.now(), error: tooLargeReason });
      return { status: 'TOO_LARGE', summary: `${label} [File too large to analyse]` };
    }

    if (row.kind === 'DOCUMENT') {
      const docExt = extensionOf(row.fileName ?? undefined);
      const imageDoc = isImageDocument(row);
      if (imageDoc && !settings.imageAnalysisEnabled) {
        // An image sent as a file: it would be analysed as an image, which is turned off.
        await this.update(row.id, { status: 'DISABLED', processedAt: this.now(), error: null });
        return { status: 'DISABLED', summary: `${label} [Not analysed: analysis of this media type is turned off]` };
      }
      if (!imageDoc && !isAcceptedDocumentExtension(docExt)) {
        await this.update(row.id, {
          status: 'UNSUPPORTED',
          processedAt: this.now(),
          error: `.${docExt} files are not accepted`,
        });
        return { status: 'UNSUPPORTED', summary: `${label} [Unsupported file type: ${docExt}]` };
      }
    }

    await this.update(row.id, { status: 'PROCESSING', error: null });
    const ext = tempExtension(row);
    let downloaded: DownloadedFile | null = null;
    try {
      downloaded = await this.deps.downloader.download(row.telegramFileId, {
        maxBytes,
        ext,
        knownSize: row.fileSize,
      });
      const item = await this.dispatch(row, downloaded, settings, caption, messageId);
      const retained = await this.retain(row, downloaded, settings, messageId, ext);
      await this.update(row.id, {
        status: 'DONE',
        extractedText: this.deps.cipher.encrypt(item.extractedText ?? null),
        description: this.deps.cipher.encrypt(item.description ?? null),
        error: null,
        processedAt: this.now(),
        storageKey: retained?.storageKey ?? null,
        expiresAt: retained?.expiresAt ?? null,
        ...(row.durationSec === null && item.durationSec !== undefined ? { durationSec: Math.round(item.durationSec) } : {}),
        ...(row.width === null && item.width !== undefined ? { width: item.width } : {}),
        ...(row.height === null && item.height !== undefined ? { height: item.height } : {}),
      });
      log.info({ messageId, mediaId: row.id, kind: row.kind, status: 'DONE' }, 'media processed');
      return { status: 'DONE', summary: item.summary, image: item.image, transcript: item.transcript };
    } catch (error) {
      const status: MediaStatus =
        error instanceof MediaTooLargeError ? 'TOO_LARGE' : error instanceof UnsupportedMediaError ? 'UNSUPPORTED' : 'FAILED';
      const description = describeError(error);
      await this.update(row.id, { status, error: description, processedAt: this.now() });
      log.warn({ messageId, mediaId: row.id, kind: row.kind, status, err: description }, 'media not analysed');
      if (status === 'TOO_LARGE') return { status, summary: `${label} [File too large to analyse]` };
      if (status === 'UNSUPPORTED') {
        const typeLabel = unsupportedLabel(error, row, downloaded?.sniffed);
        return { status, summary: `${label} [Unsupported file type: ${typeLabel}]` };
      }
      return { status, summary: `${label} [Could not be analysed]` };
    } finally {
      await removeQuietly(downloaded?.path);
    }
  }

  private async dispatch(
    row: MediaRow,
    file: DownloadedFile,
    settings: Settings,
    caption: string | null,
    messageId: number,
  ): Promise<ProcessedItem> {
    const { ai, ffmpeg } = this.deps;
    switch (row.kind) {
      case 'PHOTO': {
        const r = await processImage({ ai }, { path: file.path, sniffed: file.sniffed, caption, messageId });
        return {
          summary: `[Image] Description: ${r.description}`,
          description: r.description,
          image: settings.attachImageToReply && r.image ? r.image : undefined,
        };
      }
      case 'VOICE':
      case 'AUDIO': {
        const r = await processAudio(
          { ai, ffmpeg },
          {
            path: file.path,
            sniffed: file.sniffed,
            kind: row.kind,
            mimeType: row.mimeType,
            fileName: row.fileName,
            durationSec: row.durationSec,
            messageId,
          },
          settings,
        );
        const label = labelFor(row, r.durationSec);
        const transcriptPart = r.transcript
          ? `Transcript${r.truncated ? ' (truncated)' : ''}: "${r.transcript}"`
          : 'Transcript: (no speech detected)';
        return {
          summary: `${label} ${transcriptPart}`,
          extractedText: r.transcript,
          transcript: r.transcript || undefined,
          durationSec: r.durationSec,
        };
      }
      case 'VIDEO':
      case 'VIDEO_NOTE':
      case 'ANIMATION': {
        const r = await processVideo(
          { ai, ffmpeg },
          {
            path: file.path,
            sniffed: file.sniffed,
            kind: row.kind,
            durationSec: row.durationSec,
            width: row.width,
            height: row.height,
            caption,
            messageId,
          },
          settings,
        );
        const parts = [labelFor(row, r.durationSec)];
        if (r.transcript) parts.push(`Transcript${r.transcriptTruncated ? ' (truncated)' : ''}: "${r.transcript}"`);
        else if (r.transcriptionFailed) parts.push('Transcript: (unavailable)');
        else if (r.hasAudio && row.kind !== 'ANIMATION') parts.push('Transcript: (no speech detected)');
        parts.push(`Visual: ${r.description ?? '(analysis unavailable)'}`);
        return {
          summary: parts.join(' '),
          extractedText: r.transcript,
          description: r.description,
          durationSec: r.durationSec,
          width: r.width,
          height: r.height,
        };
      }
      case 'DOCUMENT': {
        // Screenshots are often sent as files: analyse real images as images.
        if (isSupportedImage(file.sniffed) && isImageDocument(row) && settings.imageAnalysisEnabled) {
          const r = await processImage({ ai }, { path: file.path, sniffed: file.sniffed, caption, messageId });
          return {
            summary: `${labelFor(row)} Description: ${r.description}`,
            description: r.description,
            image: settings.attachImageToReply && r.image ? r.image : undefined,
          };
        }
        const r = await processDocument(
          { path: file.path, sniffed: file.sniffed, fileName: row.fileName, mimeType: row.mimeType },
          settings,
        );
        const summary = r.text
          ? `${labelFor(row)} Extracted text${r.truncated ? ' (truncated)' : ''}: ${r.text}`
          : `${labelFor(row)} No extractable text (the document may be scanned or empty)`;
        return { summary, extractedText: r.text };
      }
      case 'STICKER':
        return { summary: labelFor(row) };
    }
  }

  /** Stores the raw file (encrypted when a key is set) when retention is enabled; failures are logged, never fatal. */
  private async retain(
    row: MediaRow,
    file: DownloadedFile,
    settings: Settings,
    messageId: number,
    ext: string,
  ): Promise<{ storageKey: string; expiresAt: Date } | null> {
    if (!settings.retainRawMedia || settings.mediaRetentionDays <= 0) return null;
    try {
      const key = mediaStorageKey(messageId, row.id, ext);
      const contentType =
        row.mimeType && /^[\w.+-]+\/[\w.+-]+$/.test(row.mimeType)
          ? row.mimeType
          : (SNIFF_CONTENT_TYPES[file.sniffed] ?? 'application/octet-stream');
      // EncryptedStorage stores ciphertext (as application/octet-stream) when a key is configured.
      await this.rawStorage.put(key, await readFile(file.path), contentType);
      return { storageKey: key, expiresAt: new Date(this.now().getTime() + settings.mediaRetentionDays * DAY_MS) };
    } catch (error) {
      log.warn({ err: describeError(error), messageId, mediaId: row.id }, 'raw media retention failed');
      return null;
    }
  }

  /** Rebuilds the summary of an item analysed by an earlier (retried) run without paying for AI again. */
  private reuseDone(row: MediaRow): ItemOutcome | null {
    const text = this.deps.cipher.decrypt(row.extractedText) ?? undefined;
    const description = this.deps.cipher.decrypt(row.description) ?? undefined;
    if (!text && !description) return null;
    const label = labelFor(row);
    switch (row.kind) {
      case 'PHOTO':
        return { status: 'DONE', summary: `${label} Description: ${description ?? ''}`.trim() };
      case 'VOICE':
      case 'AUDIO':
        return { status: 'DONE', summary: `${label} Transcript: "${text ?? ''}"`, transcript: text };
      case 'VIDEO':
      case 'VIDEO_NOTE':
      case 'ANIMATION': {
        const parts = [label];
        if (text) parts.push(`Transcript: "${text}"`);
        parts.push(`Visual: ${description ?? '(analysis unavailable)'}`);
        return { status: 'DONE', summary: parts.join(' ') };
      }
      case 'DOCUMENT':
        return {
          status: 'DONE',
          summary: description ? `${label} Description: ${description}` : `${label} Extracted text: ${text ?? ''}`,
        };
      default:
        return null;
    }
  }

  private maxBytesFor(kind: MediaKind, settings: Settings): number {
    const configured = bytesFromMb(kind === 'DOCUMENT' ? settings.maxDocumentSizeMb : settings.maxMediaSizeMb);
    return this.deps.cloudBotApi ? Math.min(configured, CLOUD_BOT_API_MAX_BYTES) : configured;
  }

  /** Limits we can check from Telegram metadata alone (no download). */
  private preflightTooLarge(row: MediaRow, settings: Settings, maxBytes: number): string | null {
    if (row.fileSize !== null && row.fileSize > maxBytes) {
      const cloud = this.deps.cloudBotApi && maxBytes === CLOUD_BOT_API_MAX_BYTES;
      return `file size ${row.fileSize} bytes exceeds ${cloud ? 'the 20 MB cloud Bot API limit' : `the ${maxBytes} byte limit`}`;
    }
    const isAudio = row.kind === 'VOICE' || row.kind === 'AUDIO';
    const isVideo = row.kind === 'VIDEO' || row.kind === 'VIDEO_NOTE' || row.kind === 'ANIMATION';
    if (isAudio || isVideo) {
      const check = checkDuration(row.durationSec, isAudio ? settings.maxAudioDurationSec : settings.maxVideoDurationSec);
      if (!check.ok) return check.reason;
    }
    return null;
  }

  private async update(id: number, data: MediaUpdate): Promise<void> {
    try {
      await this.deps.db.media.update({ where: { id }, data });
    } catch (error) {
      log.error({ err: describeError(error), mediaId: id }, 'failed to update media row');
    }
  }
}

function cleanDisplayName(name: string | null): string | undefined {
  if (!name) return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f[\]]/g, '_').trim();
  if (!cleaned) return undefined;
  return cleaned.length > 80 ? `${cleaned.slice(0, 80)}…` : cleaned;
}

/** Neutral bracketed label, e.g. "[Voice message, 12s]" or "[Document: report.pdf]". */
export function labelFor(
  row: Pick<MediaRow, 'kind' | 'durationSec' | 'fileName' | 'emoji'>,
  durationOverride?: number,
): string {
  const d = durationOverride ?? row.durationSec ?? undefined;
  const dur = d !== undefined && Number.isFinite(d) && d > 0 ? `, ${formatDuration(d)}` : '';
  const name = cleanDisplayName(row.fileName);
  switch (row.kind) {
    case 'PHOTO':
      return '[Image]';
    case 'VOICE':
      return `[Voice message${dur}]`;
    case 'AUDIO':
      return `[Audio${name ? `: ${name}` : ''}${dur}]`;
    case 'VIDEO':
      return `[Video${dur}]`;
    case 'VIDEO_NOTE':
      return `[Round video note${dur}]`;
    case 'ANIMATION':
      return `[GIF/animation${dur}]`;
    case 'DOCUMENT':
      return `[Document${name ? `: ${name}` : ''}]`;
    case 'STICKER':
      return `[Sticker${row.emoji ? ` ${row.emoji.slice(0, 8)}` : ''}]`;
  }
}

function tempExtension(row: MediaRow): string {
  const fromName = extensionOf(row.fileName ?? undefined);
  if (fromName && SAFE_EXTENSIONS.has(fromName)) return fromName;
  const mime = (row.mimeType ?? '').toLowerCase();
  switch (row.kind) {
    case 'PHOTO':
      return 'jpg';
    case 'VOICE':
      return 'ogg';
    case 'AUDIO':
      if (mime === 'audio/mpeg') return 'mp3';
      if (mime === 'audio/mp4' || mime === 'audio/x-m4a') return 'm4a';
      if (mime === 'audio/ogg') return 'ogg';
      return 'bin';
    case 'VIDEO':
    case 'VIDEO_NOTE':
    case 'ANIMATION':
      return 'mp4';
    default:
      return 'bin';
  }
}

function isImageDocument(row: MediaRow): boolean {
  const ext = extensionOf(row.fileName ?? undefined);
  const mime = (row.mimeType ?? '').toLowerCase();
  return ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext) || (!ext && mime.startsWith('image/'));
}

function unsupportedLabel(error: unknown, row: MediaRow, sniffed: SniffedType | undefined): string {
  const fromError = error instanceof UnsupportedMediaError ? error.typeLabel : undefined;
  const raw =
    fromError ||
    extensionOf(row.fileName ?? undefined) ||
    row.mimeType ||
    (sniffed && sniffed !== 'unknown' ? sniffed : '') ||
    row.kind.toLowerCase();
  return raw.replace(/[^\w./+-]/g, '').slice(0, 60) || 'unknown';
}
