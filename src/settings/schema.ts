import { z } from 'zod';
import type { Env } from '../config/env.js';
import { PROVIDER_IDS } from '../config/env.js';
import {
  defaultFallbackReply,
  defaultOwnerRequiredReply,
  defaultMediaTooLargeReply,
  defaultPersonalReply,
  defaultUnsupportedMediaReply,
} from '../config/defaults.js';

const provider = z.enum(PROVIDER_IDS);
const shortText = z.string().trim().min(1).max(1000);
const modelId = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:/@-]+$/, 'invalid model id');

export const REPLY_MODES = ['ALL_ALLOWED', 'NEW_CHATS_ONLY', 'NON_CONTACTS_ONLY', 'ALLOWLIST_ONLY', 'CUSTOM'] as const;
export const RESPONSE_STYLES = ['NATURAL', 'FRIENDLY', 'PROFESSIONAL', 'VERY_SHORT', 'CUSTOM'] as const;
export const RESPONSE_LENGTHS = ['SHORT', 'NORMAL', 'DETAILED'] as const;
export const DELAY_MODES = ['OFF', 'FAST', 'NATURAL', 'CUSTOM'] as const;
export const VOICE_MODES = ['text', 'voice', 'adaptive'] as const;

/**
 * Every runtime setting the owner can change from the admin bot.
 * One row per key in the `settings` table; missing/invalid rows fall back to defaults.
 */
export const settingsShape = {
  // ── auto reply ──
  autoReplyEnabled: z.boolean(),
  /** ISO timestamp; while in the future auto replies are paused. */
  pausedUntil: z.string().datetime().nullable(),
  replyMode: z.enum(REPLY_MODES),
  /** Mode for senders without any rule. */
  unknownUserMode: z.enum(['AUTO', 'MANUAL', 'IGNORE']),
  logWhenDisabled: z.boolean(),
  notifyWhenDisabled: z.boolean(),
  notifyManualMessages: z.boolean(),
  notifyVipMessages: z.boolean(),
  ownerName: z.string().trim().min(1).max(64),

  // ── AI ──
  aiProvider: provider,
  aiModel: modelId,
  fallbackProvider: provider.nullable(),
  fallbackModel: modelId.nullable(),
  mediaProvider: provider.nullable(),
  mediaModel: modelId.nullable(),
  transcriptionProvider: provider.nullable(),
  transcriptionModel: modelId.nullable(),
  classifierProvider: provider.nullable(),
  classifierModel: modelId.nullable(),
  ttsProvider: provider.nullable(),
  ttsModel: modelId.nullable(),
  ttsVoice: z.string().trim().max(64).nullable(),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']),
  useLlmClassifier: z.boolean(),

  // ── style ──
  responseStyle: z.enum(RESPONSE_STYLES),
  customStylePrompt: z.string().max(2000),
  responseLength: z.enum(RESPONSE_LENGTHS),

  // ── personal questions ──
  personalDetectionEnabled: z.boolean(),
  personalThreshold: z.number().min(0.5).max(0.99),
  personalReplyText: shortText,
  /** Waiting text when the owner's decision/commitment is needed (not a personal question). */
  ownerRequiredReplyText: shortText,
  /** What to do when the classifier is unsure: hand to owner (safe) or let AI answer. */
  uncertainAction: z.enum(['OWNER', 'AI']),
  personalNoticeCooldownMinutes: z.number().int().min(0).max(1440),
  fallbackReplyText: shortText,
  unsupportedMediaText: shortText,
  mediaTooLargeText: shortText,

  // ── media ──
  imageAnalysisEnabled: z.boolean(),
  voiceAnalysisEnabled: z.boolean(),
  audioAnalysisEnabled: z.boolean(),
  videoAnalysisEnabled: z.boolean(),
  videoNoteAnalysisEnabled: z.boolean(),
  documentAnalysisEnabled: z.boolean(),
  voiceResponseMode: z.enum(VOICE_MODES),
  attachImageToReply: z.boolean(),
  maxMediaSizeMb: z.number().min(1).max(2000),
  maxVideoDurationSec: z.number().int().min(5).max(3600),
  maxAudioDurationSec: z.number().int().min(5).max(7200),
  frameSampleIntervalSec: z.number().min(0.5).max(600),
  maxFrames: z.number().int().min(1).max(30),
  maxDocumentSizeMb: z.number().min(0.1).max(100),
  maxDocumentChars: z.number().int().min(500).max(500_000),
  /** NOTICE = polite reply, IGNORE = silent, OWNER = owner attention queue. */
  oversizedMediaAction: z.enum(['NOTICE', 'IGNORE', 'OWNER']),

  // ── behaviour ──
  responseDelayMode: z.enum(DELAY_MODES),
  customDelayMinSec: z.number().min(0).max(120),
  customDelayMaxSec: z.number().min(0).max(300),
  typingIndicator: z.boolean(),
  /** Wait this long for follow-up messages before answering a burst once. */
  debounceSeconds: z.number().min(0).max(60),
  historyWindow: z.number().int().min(2).max(60),
  summaryEnabled: z.boolean(),
  summaryEveryMessages: z.number().int().min(10).max(500),

  // ── limits ──
  maxMessagesPerMinute: z.number().int().min(1).max(1000),
  maxAiRequestsPerUserPerHour: z.number().int().min(1).max(100_000),
  globalAiRequestsPerMinute: z.number().int().min(1).max(100_000),
  maxDailyAiCostUsd: z.number().min(0).max(100_000),

  // ── retention ──
  messageRetentionDays: z.number().int().min(1).max(3650),
  mediaRetentionDays: z.number().int().min(0).max(3650),
  aiLogRetentionDays: z.number().int().min(1).max(3650),
  retainRawMedia: z.boolean(),

  // ── admin notifications ──
  notifyEdits: z.boolean(),
  notifyDeletes: z.boolean(),
  notifyOwnerAttention: z.boolean(),

  // ── internal bookkeeping (not shown in menus) ──
  lastCleanupAt: z.string().datetime().nullable(),
  costLimitNotifiedOn: z.string().max(10).nullable(),
} as const;

export const settingsSchema = z.object(settingsShape);
export type Settings = z.infer<typeof settingsSchema>;
export type SettingKey = keyof Settings;
export const SETTING_KEYS = Object.keys(settingsShape) as SettingKey[];

export function buildDefaultSettings(env: Env): Settings {
  const owner = env.OWNER_DISPLAY_NAME;
  const gemini = env.DEFAULT_AI_PROVIDER === 'gemini';
  return {
    autoReplyEnabled: env.AUTO_REPLY_ENABLED,
    pausedUntil: null,
    replyMode: 'CUSTOM',
    unknownUserMode: 'AUTO',
    logWhenDisabled: true,
    notifyWhenDisabled: false,
    notifyManualMessages: false,
    notifyVipMessages: true,
    ownerName: owner,

    aiProvider: env.DEFAULT_AI_PROVIDER,
    aiModel: env.DEFAULT_AI_MODEL,
    fallbackProvider: env.FALLBACK_AI_PROVIDER ?? (gemini ? 'gemini' : null),
    fallbackModel: env.FALLBACK_AI_MODEL ?? (gemini ? 'gemini-3.5-flash' : null),
    mediaProvider: env.MEDIA_AI_PROVIDER ?? null,
    mediaModel: env.MEDIA_AI_MODEL ?? null,
    transcriptionProvider: env.TRANSCRIPTION_AI_PROVIDER ?? null,
    transcriptionModel: env.TRANSCRIPTION_AI_MODEL ?? null,
    classifierProvider: env.CLASSIFIER_AI_PROVIDER ?? null,
    classifierModel: env.CLASSIFIER_AI_MODEL ?? null,
    ttsProvider: env.TTS_AI_PROVIDER ?? null,
    ttsModel: env.TTS_AI_MODEL ?? null,
    ttsVoice: null,
    reasoningEffort: env.DEFAULT_REASONING_EFFORT,
    useLlmClassifier: true,

    responseStyle: 'NATURAL',
    customStylePrompt: '',
    responseLength: 'NORMAL',

    personalDetectionEnabled: true,
    personalThreshold: 0.8,
    personalReplyText: defaultPersonalReply(owner),
    ownerRequiredReplyText: defaultOwnerRequiredReply(owner),
    uncertainAction: 'OWNER',
    personalNoticeCooldownMinutes: 30,
    fallbackReplyText: defaultFallbackReply(owner),
    unsupportedMediaText: defaultUnsupportedMediaReply(owner),
    mediaTooLargeText: defaultMediaTooLargeReply(owner),

    imageAnalysisEnabled: true,
    voiceAnalysisEnabled: true,
    audioAnalysisEnabled: true,
    videoAnalysisEnabled: true,
    videoNoteAnalysisEnabled: true,
    documentAnalysisEnabled: true,
    voiceResponseMode: env.VOICE_RESPONSE_MODE,
    attachImageToReply: true,
    maxMediaSizeMb: env.MAX_MEDIA_SIZE_MB,
    maxVideoDurationSec: env.MAX_VIDEO_DURATION,
    maxAudioDurationSec: env.MAX_AUDIO_DURATION,
    frameSampleIntervalSec: env.FRAME_SAMPLE_INTERVAL,
    maxFrames: env.MAX_FRAMES,
    maxDocumentSizeMb: env.MAX_DOCUMENT_SIZE_MB,
    maxDocumentChars: env.MAX_DOCUMENT_CHARS,
    oversizedMediaAction: 'NOTICE',

    responseDelayMode: 'FAST',
    customDelayMinSec: 2,
    customDelayMaxSec: 6,
    typingIndicator: true,
    debounceSeconds: 2,
    historyWindow: 20,
    summaryEnabled: true,
    summaryEveryMessages: 40,

    maxMessagesPerMinute: env.MAX_MESSAGES_PER_MINUTE,
    maxAiRequestsPerUserPerHour: env.MAX_AI_REQUESTS_PER_USER,
    globalAiRequestsPerMinute: env.GLOBAL_AI_REQUESTS_PER_MINUTE,
    maxDailyAiCostUsd: env.MAX_DAILY_AI_COST,

    messageRetentionDays: env.MESSAGE_RETENTION_DAYS,
    mediaRetentionDays: env.MEDIA_RETENTION_DAYS,
    aiLogRetentionDays: env.AI_LOG_RETENTION_DAYS,
    retainRawMedia: env.RETAIN_RAW_MEDIA,

    notifyEdits: true,
    notifyDeletes: true,
    notifyOwnerAttention: true,

    lastCleanupAt: null,
    costLimitNotifiedOn: null,
  };
}
