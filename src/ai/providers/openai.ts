/**
 * OpenAI — Responses API for text/vision, /audio/transcriptions and /audio/speech for audio.
 * Requests use `store: false` so conversations are not retained server-side for later retrieval.
 */
import { childLogger } from '../../logging/logger.js';
import { describeError } from '../../logging/sanitize.js';
import type { HttpRequestOptions } from '../http.js';
import {
  asRecord,
  buildVideoContextParts,
  cleanParts,
  isBadRequestMatching,
  nowMs,
  requestJson,
  requestRaw,
  requireJsonObject,
} from '../http.js';
import { openAiIsReasoningModel, openAiReasoningParams, reasoningTokenAllowance } from '../reasoning.js';
import type {
  AIProvider,
  AnalyzeImageRequest,
  AnalyzeVideoContextRequest,
  ChatTurn,
  GenerateTextRequest,
  GenerateTextResult,
  ModelInfo,
  ProviderCapabilities,
  ProviderId,
  ReasoningEffort,
  SpeechRequest,
  SpeechResult,
  TokenUsage,
  TranscribeRequest,
  TranscribeResult,
} from '../types.js';
import { AIProviderError } from '../types.js';

const log = childLogger('ai-openai');

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';
export const OPENAI_DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts';
export const OPENAI_DEFAULT_VOICE = 'alloy';
export const OPENAI_CURATED_MODELS: readonly string[] = ['gpt-5.5', 'gpt-5.5-mini', 'gpt-5-mini', 'gpt-4.1-mini'];

const MODELS_TTL_MS = 10 * 60_000;
const MODELS_FAILURE_TTL_MS = 60_000;
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
const LIST_INCLUDE = /^(gpt-|o\d|chatgpt-)/;
const LIST_EXCLUDE = /(audio|realtime|tts|transcribe|image|search|embedding|instruct)/;

export function resolveOpenAiVoice(voice: string | undefined): string {
  const v = voice?.trim().toLowerCase();
  return v && OPENAI_VOICES.includes(v) ? v : OPENAI_DEFAULT_VOICE;
}

// ───────────────────────── shared helpers ─────────────────────────

const AUDIO_EXT: Array<[RegExp, string]> = [
  [/ogg|opus/, 'ogg'],
  [/mpeg|mp3|mpga/, 'mp3'],
  [/wav|wave/, 'wav'],
  [/mp4|m4a|aac/, 'm4a'],
  [/webm/, 'webm'],
  [/flac/, 'flac'],
];

/** Safe generated multipart file name by MIME type (never derived from Telegram input). */
export function audioFileNameForMime(mimeType: string, fileName?: string): string {
  if (fileName && /^[A-Za-z0-9_-]{1,40}\.[A-Za-z0-9]{2,5}$/.test(fileName)) return fileName;
  const mime = mimeType.toLowerCase();
  const ext = AUDIO_EXT.find(([re]) => re.test(mime))?.[1] ?? 'ogg';
  return `audio.${ext}`;
}

interface TranscriptionResponse {
  text?: string;
  language?: string;
  duration?: number;
  usage?: { type?: string; input_tokens?: number; output_tokens?: number; seconds?: number };
}

/** OpenAI-style multipart `POST /audio/transcriptions` (also used by the OpenAI-compatible provider). */
export async function transcribeViaOpenAiApi(opts: {
  provider: ProviderId;
  baseUrl: string;
  headers: Record<string, string>;
  req: TranscribeRequest;
  model: string;
  timeoutMs: number;
}): Promise<TranscribeResult> {
  const started = nowMs();
  const { req } = opts;
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(req.audio)], { type: req.mimeType }), audioFileNameForMime(req.mimeType, req.fileName));
  form.append('model', opts.model);
  // whisper models return duration (needed for per-minute pricing) only with verbose_json;
  // gpt-4o-*-transcribe accept json/text only.
  form.append('response_format', /^whisper/i.test(opts.model) ? 'verbose_json' : 'json');
  const lang = req.languageHint?.trim().toLowerCase();
  if (lang && /^[a-z]{2}$/.test(lang)) form.append('language', lang);
  const res = await requestJson<TranscriptionResponse>({
    provider: opts.provider,
    url: `${opts.baseUrl}/audio/transcriptions`,
    method: 'POST',
    headers: opts.headers,
    formData: form,
    timeoutMs: opts.timeoutMs,
    label: 'transcribe',
  });
  const usage: TokenUsage = {
    inputTokens: res.usage?.type === 'tokens' ? (res.usage.input_tokens ?? 0) : 0,
    outputTokens: res.usage?.type === 'tokens' ? (res.usage.output_tokens ?? 0) : 0,
  };
  const durationSec = res.duration ?? (res.usage?.type === 'duration' ? res.usage.seconds : undefined);
  return {
    text: (res.text ?? '').trim(),
    ...(res.language ? { language: res.language } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
    usage,
    provider: opts.provider,
    model: opts.model,
    latencyMs: Math.round(nowMs() - started),
  };
}

/**
 * Prepares a JSON Schema for OpenAI strict structured outputs: every object gets
 * `additionalProperties: false` and all of its properties listed in `required` (recursively).
 */
export function toStrictJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toStrictJsonSchema);
  const obj = asRecord(schema);
  if (!obj) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'properties' || key === '$defs' || key === 'definitions' || key === 'patternProperties') {
      const map = asRecord(value);
      out[key] = map ? Object.fromEntries(Object.entries(map).map(([k, v]) => [k, toStrictJsonSchema(v)])) : value;
    } else if (key === 'items' || key === 'anyOf' || key === 'oneOf' || key === 'allOf' || key === 'not') {
      out[key] = toStrictJsonSchema(value);
    } else {
      out[key] = value;
    }
  }
  const type = obj.type;
  const isObject = type === 'object' || (Array.isArray(type) && type.includes('object')) || asRecord(obj.properties) !== undefined;
  if (isObject) {
    const props = asRecord(out.properties) ?? {};
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

function schemaName(name: string | undefined): string {
  const cleaned = (name ?? 'response').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return cleaned || 'response';
}

// ───────────────────────── wire types ─────────────────────────

interface ResponsesApiResponse {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }>;
  usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } };
}

type InputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'output_text'; text: string };

function toResponsesInput(turns: ChatTurn[]): Array<{ role: 'user' | 'assistant'; content: InputContent[] }> {
  const out: Array<{ role: 'user' | 'assistant'; content: InputContent[] }> = [];
  for (const turn of turns) {
    const parts = cleanParts(turn.parts);
    if (parts.length === 0) continue;
    const content: InputContent[] =
      turn.role === 'assistant'
        ? parts.map((p) => ({ type: 'output_text', text: p.type === 'text' ? p.text : '[image]' }))
        : parts.map((p) =>
            p.type === 'text'
              ? { type: 'input_text', text: p.text }
              : { type: 'input_image', image_url: `data:${p.image.mimeType};base64,${p.image.data.toString('base64')}` },
          );
    out.push({ role: turn.role, content });
  }
  return out;
}

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class OpenAIProvider implements AIProvider {
  readonly id = 'openai' as const;
  readonly displayName = 'OpenAI';
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private modelsCache: { models: ModelInfo[]; expiresAt: number } | undefined;
  /** Learned after 400s: per model+effort → effort to send (null = none). */
  private readonly effortOverrides = new Map<string, ReasoningEffort | null>();
  private readonly noTemperature = new Set<string>();

  constructor(opts: OpenAIProviderOptions) {
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.baseUrl = (opts.baseUrl?.trim() || OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  isConfigured(): boolean {
    return this.apiKey !== undefined;
  }

  capabilities(model?: string): ProviderCapabilities {
    if (model === undefined) {
      return { text: true, vision: true, audioTranscription: true, tts: true, reasoning: true, jsonSchema: true };
    }
    const m = model.trim().toLowerCase();
    const isTts = m.includes('tts');
    const isStt = m.includes('transcribe') || m.startsWith('whisper');
    const chat = !isTts && !isStt;
    return {
      text: chat,
      vision: chat && !/^(o1-mini|o3-mini|gpt-3\.5)/.test(m),
      audioTranscription: isStt,
      tts: isTts,
      reasoning: openAiIsReasoningModel(m),
      jsonSchema: chat,
    };
  }

  private headers(): Record<string, string> {
    if (!this.apiKey) throw new AIProviderError('openai: OPENAI_API_KEY is not set', 'openai', 'NOT_CONFIGURED');
    return { authorization: `Bearer ${this.apiKey}` };
  }

  private request(path: string, extra: Omit<HttpRequestOptions, 'provider' | 'url' | 'headers' | 'timeoutMs'> & { timeoutMs?: number }): HttpRequestOptions {
    return { provider: 'openai', url: `${this.baseUrl}${path}`, headers: this.headers(), ...extra, timeoutMs: extra.timeoutMs ?? this.timeoutMs };
  }

  async listModels(): Promise<ModelInfo[]> {
    const now = Date.now();
    if (this.modelsCache && this.modelsCache.expiresAt > now) return this.modelsCache.models;
    const curated = OPENAI_CURATED_MODELS.map((id) => ({ id }));
    if (!this.apiKey) return curated;
    try {
      const res = await requestJson<{ data?: Array<{ id?: string; created?: number }> }>(
        this.request('/models', { method: 'GET', timeoutMs: Math.min(this.timeoutMs, 15_000), maxRetries: 1, label: 'listModels' }),
      );
      const models = (res.data ?? [])
        .filter((m): m is { id: string; created?: number } => typeof m.id === 'string')
        .filter((m) => LIST_INCLUDE.test(m.id) && !LIST_EXCLUDE.test(m.id))
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .map((m) => ({ id: m.id }));
      if (models.length === 0) throw new Error('no chat models returned');
      this.modelsCache = { models, expiresAt: now + MODELS_TTL_MS };
      return models;
    } catch (error) {
      log.warn({ err: describeError(error) }, 'openai listModels failed; using curated list');
      this.modelsCache = { models: curated, expiresAt: now + MODELS_FAILURE_TTL_MS };
      return curated;
    }
  }

  async generateText(req: GenerateTextRequest): Promise<GenerateTextResult> {
    const started = nowMs();
    const model = req.model.trim();
    const input = toResponsesInput(req.messages);
    if (input.length === 0) throw new AIProviderError('openai: request has no content', 'openai', 'BAD_REQUEST');

    const effortKey = `${model}|${req.reasoningEffort ?? ''}`;
    const learned = this.effortOverrides.get(effortKey);
    let reasoning = learned === null ? undefined : openAiReasoningParams(model, learned ?? req.reasoningEffort);
    let sendTemperature = req.temperature !== undefined && !openAiIsReasoningModel(model) && !this.noTemperature.has(model);
    let strict = true;
    const adjusted = { low: false, noReasoning: false, temperature: false, strict: false };

    for (;;) {
      const body: Record<string, unknown> = { model, input, store: false };
      if (req.system?.trim()) body.instructions = req.system;
      if (req.maxOutputTokens !== undefined) {
        body.max_output_tokens = req.maxOutputTokens + (reasoning ? reasoningTokenAllowance(reasoning.reasoning.effort) : 0);
      }
      if (sendTemperature) body.temperature = req.temperature;
      if (reasoning) body.reasoning = reasoning.reasoning;
      if (req.json) {
        body.text = {
          format: {
            type: 'json_schema',
            name: schemaName(req.json.name),
            schema: strict ? toStrictJsonSchema(req.json.schema) : req.json.schema,
            strict,
          },
        };
      }

      try {
        const res = await requestJson<ResponsesApiResponse>(
          this.request('/responses', { method: 'POST', json: body, timeoutMs: req.timeoutMs, label: 'responses' }),
        );
        const parsed = this.parse(res, req.json !== undefined);
        return {
          ...parsed,
          provider: 'openai',
          model,
          latencyMs: Math.round(nowMs() - started),
        };
      } catch (error) {
        if (reasoning && isBadRequestMatching(error, /reasoning|effort|minimal/i)) {
          if (!adjusted.low && reasoning.reasoning.effort === 'minimal') {
            adjusted.low = true;
            reasoning = { reasoning: { effort: 'low' } };
            this.effortOverrides.set(effortKey, 'low');
            continue;
          }
          if (!adjusted.noReasoning) {
            adjusted.noReasoning = true;
            reasoning = undefined;
            this.effortOverrides.set(effortKey, null);
            continue;
          }
        }
        if (sendTemperature && !adjusted.temperature && isBadRequestMatching(error, /temperature/i)) {
          adjusted.temperature = true;
          sendTemperature = false;
          this.noTemperature.add(model);
          continue;
        }
        if (req.json && strict && !adjusted.strict && isBadRequestMatching(error, /schema|strict|json/i)) {
          adjusted.strict = true;
          strict = false;
          continue;
        }
        throw error;
      }
    }
  }

  private parse(res: ResponsesApiResponse, json: boolean): { text: string; usage: TokenUsage; finishReason?: string } {
    let text = '';
    let refusal: string | undefined;
    for (const item of res.output ?? []) {
      if (item.type !== 'message') continue;
      for (const c of item.content ?? []) {
        if (c.type === 'output_text' && typeof c.text === 'string') text += c.text;
        else if (c.type === 'refusal') refusal = c.refusal ?? 'refused';
      }
    }
    const reason = res.incomplete_details?.reason;
    if (!text.trim()) {
      if (refusal || reason === 'content_filter') throw new AIProviderError('openai: response refused or filtered', 'openai', 'SAFETY');
      throw new AIProviderError(`openai: empty response (status ${res.status ?? 'unknown'}${reason ? `, ${reason}` : ''})`, 'openai', 'EMPTY', {
        retryable: false,
      });
    }
    const reasoningTokens = res.usage?.output_tokens_details?.reasoning_tokens ?? 0;
    return {
      text: json ? requireJsonObject('openai', text) : text,
      usage: {
        inputTokens: res.usage?.input_tokens ?? 0,
        outputTokens: res.usage?.output_tokens ?? 0,
        ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
      },
      finishReason: res.status === 'incomplete' ? (reason ?? 'incomplete') : res.status,
    };
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

  transcribeAudio(req: TranscribeRequest): Promise<TranscribeResult> {
    return transcribeViaOpenAiApi({
      provider: 'openai',
      baseUrl: this.baseUrl,
      headers: this.headers(),
      req,
      model: req.model.trim() || OPENAI_DEFAULT_TRANSCRIPTION_MODEL,
      timeoutMs: req.timeoutMs ?? this.timeoutMs,
    });
  }

  async synthesizeSpeech(req: SpeechRequest): Promise<SpeechResult> {
    const started = nowMs();
    const model = req.model.trim() || OPENAI_DEFAULT_TTS_MODEL;
    const res = await requestRaw(
      this.request('/audio/speech', {
        method: 'POST',
        json: { model, input: req.text, voice: resolveOpenAiVoice(req.voice), response_format: 'opus' },
        timeoutMs: req.timeoutMs,
        label: 'speech',
      }),
    );
    if (res.body.length === 0) throw new AIProviderError('openai: TTS returned no audio', 'openai', 'EMPTY', { retryable: false });
    // The speech endpoint reports no usage; rough estimate for cost stats (~4 chars/token in, ~1.4 audio tokens/char out).
    return {
      audio: res.body,
      format: 'ogg_opus',
      usage: { inputTokens: Math.ceil(req.text.length / 4), outputTokens: Math.ceil(req.text.length * 1.4) },
      provider: 'openai',
      model,
      latencyMs: Math.round(nowMs() - started),
    };
  }
}
