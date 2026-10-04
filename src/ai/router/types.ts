import type {
  AnalyzeImageRequest,
  AnalyzeVideoContextRequest,
  GenerateTextRequest,
  GenerateTextResult,
  ProviderId,
  SpeechRequest,
  SpeechResult,
  TranscribeRequest,
  TranscribeResult,
} from '../types.js';

export interface AiCallContext {
  /** DB id of the source message (stored in usage_stats). */
  messageId?: number;
}

export interface RoutedResult<T> {
  result: T;
  provider: ProviderId;
  model: string;
  /** True when the primary target failed and a fallback produced the result. */
  usedFallback: boolean;
  /** Estimated cost of the successful call (USD). */
  costUsd: number;
  /** Reasoning effort actually requested (undefined when not supported/sent). */
  reasoningEffort?: string;
}

/**
 * Picks provider/model per operation from runtime settings and walks the fallback chain:
 * primary → fallback → AllProvidersFailedError (caller sends the safe fallback text).
 * Every attempt (success or failure) is recorded through UsageRecorder.
 */
export interface AiRouter {
  /** Conversational reply (settings.aiProvider/aiModel → fallbackProvider/fallbackModel). */
  generateReply(req: Omit<GenerateTextRequest, 'model'>, ctx?: AiCallContext): Promise<RoutedResult<GenerateTextResult>>;
  /** Conversation summary; same chain as replies, low reasoning. */
  summarize(req: Omit<GenerateTextRequest, 'model'>, ctx?: AiCallContext): Promise<RoutedResult<GenerateTextResult>>;
  /** Structured classification (classifier target → primary → fallback). Always JSON. */
  classify(req: Omit<GenerateTextRequest, 'model'>, ctx?: AiCallContext): Promise<RoutedResult<GenerateTextResult>>;
  /** Vision (media target → primary → fallback), only vision-capable targets. */
  analyzeImage(req: Omit<AnalyzeImageRequest, 'model'>, ctx?: AiCallContext): Promise<RoutedResult<GenerateTextResult>>;
  /** Speech-to-text (transcription target → any configured provider with transcription). */
  transcribe(req: Omit<TranscribeRequest, 'model'>, ctx?: AiCallContext): Promise<RoutedResult<TranscribeResult>>;
  /** Frames + transcript (media target → primary → fallback). */
  analyzeVideo(req: Omit<AnalyzeVideoContextRequest, 'model'>, ctx?: AiCallContext): Promise<RoutedResult<GenerateTextResult>>;
  /** Text-to-speech (tts target → any configured provider with TTS). */
  synthesizeSpeech(req: Omit<SpeechRequest, 'model'>, ctx?: AiCallContext): Promise<RoutedResult<SpeechResult>>;
  /** Whether a usable (configured + capable) target exists for the capability. */
  canTranscribe(): Promise<boolean>;
  canSynthesizeSpeech(): Promise<boolean>;
}
