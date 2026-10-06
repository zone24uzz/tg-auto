/**
 * Generic OpenAI-compatible Chat Completions endpoint (OpenRouter, Groq, Together, vLLM, Ollama, LM Studio…).
 * Capabilities are declared via OPENAI_COMPAT_SUPPORTS_* flags because they vary per server/model.
 */
import { childLogger } from '../../logging/logger.js';
import { describeError } from '../../logging/sanitize.js';
import type { HttpRequestOptions } from '../http.js';
import {
  buildVideoContextParts,
  cleanParts,
  isBadRequestMatching,
  jsonSchemaInstruction,
  nowMs,
  requestJson,
  requireJsonObject,
} from '../http.js';
import { openAiCompatReasoningParams } from '../reasoning.js';
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
import { transcribeViaOpenAiApi } from './openai.js';

const log = childLogger('ai-openai-compat');

export const OPENAI_COMPAT_DEFAULT_TRANSCRIPTION_MODEL = 'whisper-1';
const MODELS_TTL_MS = 10 * 60_000;
const MODELS_FAILURE_TTL_MS = 60_000;

type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | Array<{ type?: string; text?: string }> | null; refusal?: string | null };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
}

/** Removes <think>…</think> blocks emitted by many open reasoning models (DeepSeek-R1, Qwen…). */
export function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
}

export interface OpenAICompatibleProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  /** Comma-separated model ids (OPENAI_COMPAT_MODELS). */
  models?: string;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  supportsTranscription?: boolean;
  timeoutMs?: number;
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly id = 'openai_compat' as const;
  readonly displayName = 'OpenAI-compatible';
  private readonly baseUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly configuredModels: string[];
  private readonly supportsVision: boolean;
  private readonly supportsReasoning: boolean;
  private readonly supportsTranscription: boolean;
  private readonly timeoutMs: number;
  private modelsCache: { models: ModelInfo[]; expiresAt: number } | undefined;

  constructor(opts: OpenAICompatibleProviderOptions) {
    this.baseUrl = opts.baseUrl?.trim().replace(/\/+$/, '') || undefined;
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.configuredModels = (opts.models ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.supportsVision = opts.supportsVision ?? false;
    this.supportsReasoning = opts.supportsReasoning ?? false;
    this.supportsTranscription = opts.supportsTranscription ?? false;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  isConfigured(): boolean {
    return this.baseUrl !== undefined;
  }

  capabilities(_model?: string): ProviderCapabilities {
    return {
      text: true,
      vision: this.supportsVision,
      audioTranscription: this.supportsTranscription,
      tts: false,
      reasoning: this.supportsReasoning,
      jsonSchema: false,
    };
  }

  private request(
    path: string,
    extra: Omit<HttpRequestOptions, 'provider' | 'url' | 'headers' | 'timeoutMs'> & { timeoutMs?: number },
  ): HttpRequestOptions {
    if (!this.baseUrl) throw new AIProviderError('openai_compat: OPENAI_COMPAT_BASE_URL is not set', 'openai_compat', 'NOT_CONFIGURED');
    return {
      provider: 'openai_compat',
      url: `${this.baseUrl}${path}`,
      headers: this.authHeaders(),
      ...extra,
      timeoutMs: extra.timeoutMs ?? this.timeoutMs,
    };
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.configuredModels.length > 0) return this.configuredModels.map((id) => ({ id }));
    if (!this.baseUrl) return [];
    const now = Date.now();
    if (this.modelsCache && this.modelsCache.expiresAt > now) return this.modelsCache.models;
    try {
      const res = await requestJson<{ data?: Array<{ id?: string }> }>(
        this.request('/models', { method: 'GET', timeoutMs: Math.min(this.timeoutMs, 15_000), maxRetries: 1, label: 'listModels' }),
      );
      const models = (res.data ?? []).filter((m): m is { id: string } => typeof m.id === 'string').map((m) => ({ id: m.id }));
      this.modelsCache = { models, expiresAt: now + MODELS_TTL_MS };
      return models;
    } catch (error) {
      log.warn({ err: describeError(error) }, 'openai_compat listModels failed');
      this.modelsCache = { models: [], expiresAt: now + MODELS_FAILURE_TTL_MS };
      return [];
    }
  }

  private toMessages(system: string | undefined, turns: ChatTurn[]): ChatMessage[] {
    const out: ChatMessage[] = [];
    if (system) out.push({ role: 'system', content: system });
    for (const turn of turns) {
      const parts = cleanParts(turn.parts);
      if (parts.length === 0) continue;
      const hasImage = parts.some((p) => p.type === 'image');
      if (turn.role === 'user' && hasImage && this.supportsVision) {
        out.push({
          role: 'user',
          content: parts.map(
            (p): ChatContentPart => {
              if (p.type === 'text') return { type: 'text', text: p.text };
              if (p.type === 'tool_call' || p.type === 'tool_result') return { type: 'text', text: `[${p.type}]` };
              return { type: 'image_url', image_url: { url: `data:${(p as any).image.mimeType};base64,${(p as any).image.data.toString('base64')}` } };
            }
          ),
        });
      } else {
        const text = parts.map((p) => (p.type === 'text' ? p.text : '[image omitted]')).join('\n');
        out.push({ role: turn.role, content: text });
      }
    }
    return out;
  }

  async generateText(req: GenerateTextRequest): Promise<GenerateTextResult> {
    const started = nowMs();
    const model = req.model.trim();
    const system = [req.system?.trim(), req.json ? jsonSchemaInstruction(req.json.schema) : undefined]
      .filter((s): s is string => Boolean(s))
      .join('\n\n');
    const messages = this.toMessages(system || undefined, req.messages);
    if (!messages.some((m) => m.role !== 'system')) {
      throw new AIProviderError('openai_compat: request has no content', 'openai_compat', 'BAD_REQUEST');
    }

    let reasoning = openAiCompatReasoningParams(this.supportsReasoning, req.reasoningEffort);
    let sendTemperature = req.temperature !== undefined;
    let jsonFormat = req.json !== undefined;
    let maxTokensKey: 'max_tokens' | 'max_completion_tokens' = 'max_tokens';
    const adjusted = { reasoning: false, temperature: false, json: false, maxTokens: false };

    for (;;) {
      const body: Record<string, unknown> = { model, messages, stream: false };
      if (req.maxOutputTokens !== undefined) body[maxTokensKey] = req.maxOutputTokens;
      if (sendTemperature) body.temperature = req.temperature;
      if (jsonFormat) body.response_format = { type: 'json_object' };
      if (reasoning) Object.assign(body, reasoning);

      try {
        const res = await requestJson<ChatCompletionResponse>(
          this.request('/chat/completions', { method: 'POST', json: body, timeoutMs: req.timeoutMs, label: 'chat' }),
        );
        const choice = res.choices?.[0];
        const raw = choice?.message?.content;
        const content = Array.isArray(raw) ? raw.map((c) => (typeof c.text === 'string' ? c.text : '')).join('') : (raw ?? '');
        const text = stripThinkBlocks(content);
        if (!text) {
          if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) {
            throw new AIProviderError('openai_compat: response refused or filtered', 'openai_compat', 'SAFETY');
          }
          throw new AIProviderError(
            `openai_compat: empty response (finish_reason ${choice?.finish_reason ?? 'unknown'})`,
            'openai_compat',
            'EMPTY',
            { retryable: false },
          );
        }
        const reasoningTokens = res.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
        return {
          text: req.json ? requireJsonObject('openai_compat', text) : text,
          usage: {
            inputTokens: res.usage?.prompt_tokens ?? 0,
            outputTokens: res.usage?.completion_tokens ?? 0,
            ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
          },
          provider: 'openai_compat',
          model,
          finishReason: choice?.finish_reason,
          latencyMs: Math.round(nowMs() - started),
        };
      } catch (error) {
        if (reasoning && !adjusted.reasoning && isBadRequestMatching(error, /reasoning/i)) {
          adjusted.reasoning = true;
          reasoning = undefined;
          continue;
        }
        if (sendTemperature && !adjusted.temperature && isBadRequestMatching(error, /temperature/i)) {
          adjusted.temperature = true;
          sendTemperature = false;
          continue;
        }
        if (jsonFormat && !adjusted.json && isBadRequestMatching(error, /response_format|json_object|json mode/i)) {
          adjusted.json = true;
          jsonFormat = false; // the schema instruction in the system prompt + local parsing still apply
          continue;
        }
        if (req.maxOutputTokens !== undefined && !adjusted.maxTokens && isBadRequestMatching(error, /max_tokens/i)) {
          adjusted.maxTokens = true;
          maxTokensKey = 'max_completion_tokens';
          continue;
        }
        throw error;
      }
    }
  }

  analyzeImage(req: AnalyzeImageRequest): Promise<GenerateTextResult> {
    if (!this.supportsVision) return Promise.reject(this.unsupported('vision'));
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
    if (!this.supportsVision) return Promise.reject(this.unsupported('vision'));
    return this.generateText({
      model: req.model,
      system: req.system,
      messages: [{ role: 'user', parts: buildVideoContextParts(req) }],
      maxOutputTokens: req.maxOutputTokens,
      reasoningEffort: req.reasoningEffort,
      timeoutMs: req.timeoutMs,
    });
  }

  async transcribeAudio(req: TranscribeRequest): Promise<TranscribeResult> {
    if (!this.supportsTranscription) throw this.unsupported('audio transcription');
    if (!this.baseUrl) throw new AIProviderError('openai_compat: OPENAI_COMPAT_BASE_URL is not set', 'openai_compat', 'NOT_CONFIGURED');
    return transcribeViaOpenAiApi({
      provider: 'openai_compat',
      baseUrl: this.baseUrl,
      headers: this.authHeaders(),
      req,
      model: req.model.trim() || OPENAI_COMPAT_DEFAULT_TRANSCRIPTION_MODEL,
      timeoutMs: req.timeoutMs ?? this.timeoutMs,
    });
  }

  private unsupported(what: string): AIProviderError {
    return new AIProviderError(`openai_compat: ${what} is not enabled for this endpoint`, 'openai_compat', 'UNSUPPORTED', {
      retryable: false,
    });
  }
}
