import type { ProviderId } from '../config/env.js';

export type { ProviderId };

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

/** Operation names recorded in usage_stats. */
export type AiOperation = 'TEXT' | 'CLASSIFY' | 'VISION' | 'TRANSCRIBE' | 'VIDEO' | 'SUMMARY' | 'TTS';

export interface ImageInput {
  data: Buffer;
  /** image/jpeg | image/png | image/webp | image/gif */
  mimeType: string;
}

export type ContentPart = { type: 'text'; text: string } | { type: 'image'; image: ImageInput };

export interface ChatTurn {
  role: 'user' | 'assistant';
  parts: ContentPart[];
}

export interface JsonOutputSpec {
  /** JSON Schema (draft-07 subset: type/properties/required/enum/items/description). */
  schema: Record<string, unknown>;
  name?: string;
}

export interface GenerateTextRequest {
  model: string;
  /** Trusted instructions only. Untrusted user content must go in `messages`. */
  system?: string;
  messages: ChatTurn[];
  maxOutputTokens?: number;
  temperature?: number;
  /** Mapped to provider-specific parameters; omitted when the model does not support it. */
  reasoningEffort?: ReasoningEffort;
  /** Ask for a JSON object matching the schema; `text` will contain the JSON string. */
  json?: JsonOutputSpec;
  timeoutMs?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
}

export interface GenerateTextResult {
  text: string;
  usage: TokenUsage;
  provider: ProviderId;
  model: string;
  finishReason?: string;
  latencyMs: number;
}

export interface AnalyzeImageRequest {
  model: string;
  images: ImageInput[];
  /** Instruction + any (untrusted) caption, already framed by the caller. */
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  timeoutMs?: number;
}

export interface TranscribeRequest {
  model: string;
  audio: Buffer;
  /** audio/ogg | audio/mpeg | audio/wav | audio/mp4 | audio/webm | audio/flac ... */
  mimeType: string;
  /** Used for multipart uploads; never derived from Telegram input. */
  fileName?: string;
  languageHint?: string;
  timeoutMs?: number;
}

export interface TranscribeResult {
  text: string;
  language?: string;
  usage: TokenUsage;
  durationSec?: number;
  provider: ProviderId;
  model: string;
  latencyMs: number;
}

export interface VideoFrame extends ImageInput {
  timestampSec: number;
}

export interface AnalyzeVideoContextRequest {
  model: string;
  frames: VideoFrame[];
  transcript?: string;
  metadata: {
    kind: 'video' | 'video_note' | 'animation';
    durationSec?: number;
    width?: number;
    height?: number;
    hasAudio?: boolean;
  };
  /** Instruction + any (untrusted) caption, already framed by the caller. */
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  timeoutMs?: number;
}

export interface SpeechRequest {
  model: string;
  text: string;
  voice?: string;
  timeoutMs?: number;
}

export interface SpeechResult {
  audio: Buffer;
  /** ogg_opus can be sent with sendVoice directly; others need ffmpeg conversion. */
  format: 'ogg_opus' | 'mp3' | 'wav' | 'pcm16';
  sampleRate?: number;
  usage: TokenUsage;
  provider: ProviderId;
  model: string;
  latencyMs: number;
}

export interface ProviderCapabilities {
  text: boolean;
  vision: boolean;
  audioTranscription: boolean;
  tts: boolean;
  reasoning: boolean;
  jsonSchema: boolean;
}

export interface ModelInfo {
  id: string;
  displayName?: string;
}

export interface AIProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  /** True when credentials/base URL are present. */
  isConfigured(): boolean;
  /** Capabilities for a given model (or the provider in general). */
  capabilities(model?: string): ProviderCapabilities;
  /** Models usable for chat (live list when the API offers one, curated fallback otherwise). */
  listModels(): Promise<ModelInfo[]>;
  generateText(req: GenerateTextRequest): Promise<GenerateTextResult>;
  analyzeImage(req: AnalyzeImageRequest): Promise<GenerateTextResult>;
  transcribeAudio(req: TranscribeRequest): Promise<TranscribeResult>;
  analyzeVideoContext(req: AnalyzeVideoContextRequest): Promise<GenerateTextResult>;
  synthesizeSpeech?(req: SpeechRequest): Promise<SpeechResult>;
}

export type AIErrorCode =
  | 'RATE_LIMIT'
  | 'AUTH'
  | 'BAD_REQUEST'
  | 'UNSUPPORTED'
  | 'TIMEOUT'
  | 'SERVER'
  | 'NETWORK'
  | 'SAFETY'
  | 'EMPTY'
  | 'NOT_CONFIGURED';

export class AIProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: ProviderId,
    public readonly code: AIErrorCode,
    public readonly options: { status?: number; retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'AIProviderError';
  }

  get retryable(): boolean {
    return this.options.retryable ?? ['RATE_LIMIT', 'TIMEOUT', 'SERVER', 'NETWORK'].includes(this.code);
  }
}

export class AllProvidersFailedError extends Error {
  constructor(
    public readonly operation: AiOperation,
    public readonly attempts: Array<{ provider: ProviderId; model: string; error: string }>,
  ) {
    super(
      `All AI providers failed for ${operation}${
        attempts.length ? `: ${attempts.map((a) => `${a.model}: ${a.error}`).join('; ').slice(0, 600)}` : ''
      }`,
    );
    this.name = 'AllProvidersFailedError';
  }
}
