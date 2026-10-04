/**
 * Anthropic Messages API (raw HTTP). Text + vision only — no audio input or TTS.
 * JSON output is emulated: the schema goes into the system prompt and the first top-level
 * JSON object is extracted and validated locally.
 */
import { childLogger } from '../../logging/logger.js';
import { describeError } from '../../logging/sanitize.js';
import type { HttpRequestOptions } from '../http.js';
import {
  buildVideoContextParts,
  isBadRequestMatching,
  jsonSchemaInstruction,
  normalizeTurns,
  nowMs,
  requestJson,
  requireJsonObject,
} from '../http.js';
import type { AnthropicReasoningResult } from '../reasoning.js';
import { anthropicReasoningParams, anthropicSupportsReasoning, anthropicSupportsTemperature } from '../reasoning.js';
import type {
  AIProvider,
  AnalyzeImageRequest,
  AnalyzeVideoContextRequest,
  ChatTurn,
  GenerateTextRequest,
  GenerateTextResult,
  ModelInfo,
  ProviderCapabilities,
  TranscribeRequest,
  TranscribeResult,
} from '../types.js';
import { AIProviderError } from '../types.js';

const log = childLogger('ai-anthropic');

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 1024;
export const ANTHROPIC_CURATED_MODELS: readonly string[] = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'];

const MODELS_TTL_MS = 10 * 60_000;
const MODELS_FAILURE_TTL_MS = 60_000;
const MAX_TOKENS_CAP = 64_000;

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

interface MessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function toAnthropicMessages(turns: ChatTurn[]): Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> {
  return normalizeTurns(turns).map((turn) => ({
    role: turn.role,
    content: turn.parts.map((p): AnthropicBlock => {
      if (p.type === 'text') return { type: 'text', text: p.text };
      // Images are only allowed in user turns.
      if (turn.role === 'assistant') return { type: 'text', text: '[image]' };
      return { type: 'image', source: { type: 'base64', media_type: p.image.mimeType, data: p.image.data.toString('base64') } };
    }),
  }));
}

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic' as const;
  readonly displayName = 'Anthropic Claude';
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private modelsCache: { models: ModelInfo[]; expiresAt: number } | undefined;
  private readonly noReasoning = new Set<string>();
  private readonly noTemperature = new Set<string>();

  constructor(opts: AnthropicProviderOptions) {
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.baseUrl = (opts.baseUrl?.trim() || ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  isConfigured(): boolean {
    return this.apiKey !== undefined;
  }

  capabilities(model?: string): ProviderCapabilities {
    return {
      text: true,
      vision: true,
      audioTranscription: false,
      tts: false,
      reasoning: model === undefined ? true : anthropicSupportsReasoning(model),
      jsonSchema: false,
    };
  }

  private request(
    path: string,
    extra: Omit<HttpRequestOptions, 'provider' | 'url' | 'headers' | 'timeoutMs'> & { timeoutMs?: number },
  ): HttpRequestOptions {
    if (!this.apiKey) throw new AIProviderError('anthropic: ANTHROPIC_API_KEY is not set', 'anthropic', 'NOT_CONFIGURED');
    return {
      provider: 'anthropic',
      url: `${this.baseUrl}${path}`,
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      ...extra,
      timeoutMs: extra.timeoutMs ?? this.timeoutMs,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const now = Date.now();
    if (this.modelsCache && this.modelsCache.expiresAt > now) return this.modelsCache.models;
    const curated = ANTHROPIC_CURATED_MODELS.map((id) => ({ id }));
    if (!this.apiKey) return curated;
    try {
      const res = await requestJson<{ data?: Array<{ id?: string; display_name?: string }> }>(
        this.request('/models?limit=100', { method: 'GET', timeoutMs: Math.min(this.timeoutMs, 15_000), maxRetries: 1, label: 'listModels' }),
      );
      const models = (res.data ?? [])
        .filter((m): m is { id: string; display_name?: string } => typeof m.id === 'string' && m.id.startsWith('claude'))
        .map((m) => (m.display_name ? { id: m.id, displayName: m.display_name } : { id: m.id }));
      if (models.length === 0) throw new Error('no models returned');
      this.modelsCache = { models, expiresAt: now + MODELS_TTL_MS };
      return models;
    } catch (error) {
      log.warn({ err: describeError(error) }, 'anthropic listModels failed; using curated list');
      this.modelsCache = { models: curated, expiresAt: now + MODELS_FAILURE_TTL_MS };
      return curated;
    }
  }

  async generateText(req: GenerateTextRequest): Promise<GenerateTextResult> {
    const started = nowMs();
    const model = req.model.trim();
    const messages = toAnthropicMessages(req.messages);
    if (messages.length === 0) throw new AIProviderError('anthropic: request has no content', 'anthropic', 'BAD_REQUEST');

    const systemParts = [req.system?.trim(), req.json ? jsonSchemaInstruction(req.json.schema) : undefined].filter(
      (s): s is string => Boolean(s),
    );
    const system = systemParts.join('\n\n');
    const maxOutput = req.maxOutputTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;

    let reasoning: AnthropicReasoningResult | undefined = this.noReasoning.has(model)
      ? undefined
      : anthropicReasoningParams(model, req.reasoningEffort, maxOutput);
    let allowTemperature = anthropicSupportsTemperature(model) && !this.noTemperature.has(model);
    let droppedReasoning = false;
    let droppedTemperature = false;

    for (;;) {
      const sendTemperature = req.temperature !== undefined && allowTemperature && !reasoning?.disallowTemperature;
      const body: Record<string, unknown> = {
        model,
        max_tokens: Math.min(MAX_TOKENS_CAP, reasoning?.maxTokens ?? maxOutput),
        messages,
      };
      if (system) body.system = system;
      if (sendTemperature && req.temperature !== undefined) body.temperature = Math.min(1, Math.max(0, req.temperature));
      if (reasoning) Object.assign(body, reasoning.params);

      try {
        const res = await requestJson<MessagesResponse>(
          this.request('/messages', { method: 'POST', json: body, timeoutMs: req.timeoutMs, label: 'messages' }),
        );
        if (res.stop_reason === 'refusal') throw new AIProviderError('anthropic: request refused', 'anthropic', 'SAFETY');
        const text = (res.content ?? [])
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text ?? '')
          .join('');
        if (!text.trim()) {
          throw new AIProviderError(`anthropic: empty response (stop_reason ${res.stop_reason ?? 'unknown'})`, 'anthropic', 'EMPTY', {
            retryable: false,
          });
        }
        return {
          text: req.json ? requireJsonObject('anthropic', text) : text,
          usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
          provider: 'anthropic',
          model,
          finishReason: res.stop_reason,
          latencyMs: Math.round(nowMs() - started),
        };
      } catch (error) {
        if (reasoning && !droppedReasoning && isBadRequestMatching(error, /effort|output_config|thinking|budget/i)) {
          droppedReasoning = true;
          reasoning = undefined;
          this.noReasoning.add(model);
          continue;
        }
        if (sendTemperature && !droppedTemperature && isBadRequestMatching(error, /temperature|sampling/i)) {
          droppedTemperature = true;
          allowTemperature = false;
          this.noTemperature.add(model);
          continue;
        }
        throw error;
      }
    }
  }

  analyzeImage(req: AnalyzeImageRequest): Promise<GenerateTextResult> {
    return this.generateText({
      model: req.model,
      system: req.system,
      messages: [
        {
          role: 'user',
          parts: [...req.images.map((image) => ({ type: 'image' as const, image })), { type: 'text', text: req.prompt }],
        },
      ],
      maxOutputTokens: req.maxOutputTokens,
      reasoningEffort: req.reasoningEffort,
      timeoutMs: req.timeoutMs,
    });
  }

  analyzeVideoContext(req: AnalyzeVideoContextRequest): Promise<GenerateTextResult> {
    return this.generateText({
      model: req.model,
      system: req.system,
      messages: [{ role: 'user', parts: buildVideoContextParts(req) }],
      maxOutputTokens: req.maxOutputTokens,
      reasoningEffort: req.reasoningEffort,
      timeoutMs: req.timeoutMs,
    });
  }

  transcribeAudio(_req: TranscribeRequest): Promise<TranscribeResult> {
    return Promise.reject(
      new AIProviderError('anthropic: audio transcription is not supported', 'anthropic', 'UNSUPPORTED', { retryable: false }),
    );
  }
}
