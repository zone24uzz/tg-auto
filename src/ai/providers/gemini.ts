/**
 * Google Gemini (Generative Language REST API, v1beta).
 * Auth via `x-goog-api-key` header — the key never goes into the URL.
 */
import { childLogger } from '../../logging/logger.js';
import { describeError } from '../../logging/sanitize.js';
import {
  buildVideoContextParts,
  isBadRequestMatching,
  jsonSchemaInstruction,
  normalizeTurns,
  nowMs,
  requestJson,
  requireJsonObject,
} from '../http.js';
import type { GeminiThinkingConfig } from '../reasoning.js';
import { geminiSupportsReasoning, geminiThinkingConfig, reasoningTokenAllowance } from '../reasoning.js';
import type {
  AIProvider,
  AnalyzeImageRequest,
  AnalyzeVideoContextRequest,
  ChatTurn,
  GenerateTextRequest,
  GenerateTextResult,
  JsonOutputSpec,
  ModelInfo,
  ProviderCapabilities,
  ReasoningEffort,
  SpeechRequest,
  SpeechResult,
  TokenUsage,
  TranscribeRequest,
  TranscribeResult,
} from '../types.js';
import { AIProviderError } from '../types.js';

const log = childLogger('ai-gemini');

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
/** gemini-3.5-transcribe returned empty transcripts in live tests (2026-10-04); the multimodal flash model works. */
export const GEMINI_DEFAULT_TRANSCRIPTION_MODEL = 'gemini-3.8-flash';
export const GEMINI_DEFAULT_TTS_MODEL = 'gemini-3.8-flash-tts';
export const GEMINI_DEFAULT_VOICE = 'Kore';
export const GEMINI_CURATED_MODELS: readonly string[] = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-pro-preview',
];

const TRANSCRIBE_PROMPT = 'Transcribe this audio verbatim in its original language. Output only the transcript.';
const MODELS_TTL_MS = 10 * 60_000;
const MODELS_FAILURE_TTL_MS = 60_000;
const MAX_OUTPUT_CAP = 65_536;
const LIST_EXCLUDE =
  /(tts|image|embedding|veo|lyria|live|robotics|computer-use|deep-research|antigravity|aqa|native-audio|transcribe|banana)/i;
const SAFETY_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);

/** Prebuilt TTS voices; anything else (e.g. an OpenAI voice name left in settings) falls back to Kore. */
const GEMINI_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
];

export function resolveGeminiVoice(voice: string | undefined): string {
  if (!voice) return GEMINI_DEFAULT_VOICE;
  const match = GEMINI_VOICES.find((v) => v.toLowerCase() === voice.trim().toLowerCase());
  return match ?? GEMINI_DEFAULT_VOICE;
}

// ── wire types (only the fields we read) ──
type GeminiRequestPart = { text: string } | { inline_data: { mime_type: string; data: string } };
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiRequestPart[];
}
interface GeminiResponsePart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
}
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiResponsePart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}
interface GeminiModelsResponse {
  models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>;
  nextPageToken?: string;
}

export interface GeminiProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Default per-request timeout (requests may override). */
  timeoutMs?: number;
}

interface RunParams {
  model: string;
  system?: string;
  contents: GeminiContent[];
  maxOutputTokens?: number;
  temperature?: number;
  effort?: ReasoningEffort;
  json?: JsonOutputSpec;
  timeoutMs?: number;
  label: string;
  allowEmpty?: boolean;
}

interface RunResult {
  text: string;
  usage: TokenUsage;
  finishReason?: string;
}

function stripModelsPrefix(model: string): string {
  return model.trim().replace(/^models\//, '');
}

function usageOf(res: GeminiResponse): TokenUsage {
  const u = res.usageMetadata ?? {};
  const thoughts = u.thoughtsTokenCount ?? 0;
  return {
    inputTokens: u.promptTokenCount ?? 0,
    // Thinking tokens are billed as output.
    outputTokens: (u.candidatesTokenCount ?? 0) + thoughts,
    ...(thoughts > 0 ? { reasoningTokens: thoughts } : {}),
  };
}

function toGeminiContents(turns: ChatTurn[]): GeminiContent[] {
  return normalizeTurns(turns).map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: turn.parts.map(
      (p): GeminiRequestPart =>
        p.type === 'text'
          ? { text: p.text }
          : { inline_data: { mime_type: p.image.mimeType, data: p.image.data.toString('base64') } },
    ),
  }));
}

export class GeminiProvider implements AIProvider {
  readonly id = 'gemini' as const;
  readonly displayName = 'Google Gemini';
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private modelsCache: { models: ModelInfo[]; expiresAt: number } | undefined;
  /** Learned per model+effort after a thinking-related 400, so later calls skip the failing variant. */
  private readonly thinkingOverrides = new Map<string, GeminiThinkingConfig | null>();

  constructor(opts: GeminiProviderOptions) {
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.baseUrl = (opts.baseUrl?.trim() || GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  isConfigured(): boolean {
    return this.apiKey !== undefined;
  }

  capabilities(model?: string): ProviderCapabilities {
    const m = model ? stripModelsPrefix(model).toLowerCase() : undefined;
    const isTts = m !== undefined && m.includes('tts');
    const isTranscribe = m !== undefined && m.includes('transcribe');
    return {
      text: !isTts,
      vision: !isTts && !isTranscribe,
      audioTranscription: !isTts,
      tts: m === undefined ? true : isTts,
      reasoning: m === undefined ? true : geminiSupportsReasoning(m),
      jsonSchema: !isTts && !(m?.startsWith('gemma-') ?? false),
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const now = Date.now();
    if (this.modelsCache && this.modelsCache.expiresAt > now) return this.modelsCache.models;
    const curated = GEMINI_CURATED_MODELS.map((id) => ({ id }));
    if (!this.apiKey) return curated;
    try {
      const out: ModelInfo[] = [];
      const seen = new Set<string>();
      let pageToken: string | undefined;
      for (let page = 0; page < 5; page++) {
        const qs = `pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const res = await requestJson<GeminiModelsResponse>({
          provider: 'gemini',
          url: `${this.baseUrl}/models?${qs}`,
          method: 'GET',
          headers: { 'x-goog-api-key': this.apiKey },
          timeoutMs: Math.min(this.timeoutMs, 15_000),
          maxRetries: 1,
          label: 'listModels',
        });
        for (const m of res.models ?? []) {
          if (!m.name || !(m.supportedGenerationMethods ?? []).includes('generateContent')) continue;
          const id = stripModelsPrefix(m.name);
          if (LIST_EXCLUDE.test(id) || seen.has(id)) continue;
          seen.add(id);
          out.push(m.displayName ? { id, displayName: m.displayName } : { id });
        }
        pageToken = res.nextPageToken;
        if (!pageToken) break;
      }
      if (out.length === 0) throw new Error('no chat-capable models returned');
      this.modelsCache = { models: out, expiresAt: now + MODELS_TTL_MS };
      return out;
    } catch (error) {
      log.warn({ err: describeError(error) }, 'gemini listModels failed; using curated list');
      this.modelsCache = { models: curated, expiresAt: now + MODELS_FAILURE_TTL_MS };
      return curated;
    }
  }

  async generateText(req: GenerateTextRequest): Promise<GenerateTextResult> {
    const started = nowMs();
    const model = stripModelsPrefix(req.model);
    const res = await this.run({
      model,
      system: req.system,
      contents: toGeminiContents(req.messages),
      maxOutputTokens: req.maxOutputTokens,
      temperature: req.temperature,
      effort: req.reasoningEffort,
      json: req.json,
      timeoutMs: req.timeoutMs,
      label: 'generateContent',
    });
    return {
      text: res.text,
      usage: res.usage,
      provider: 'gemini',
      model,
      finishReason: res.finishReason,
      latencyMs: Math.round(nowMs() - started),
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

  async transcribeAudio(req: TranscribeRequest): Promise<TranscribeResult> {
    const started = nowMs();
    const model = stripModelsPrefix(req.model || GEMINI_DEFAULT_TRANSCRIPTION_MODEL);
    const hint = req.languageHint?.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 32).trim();
    const instruction = hint
      ? `${TRANSCRIBE_PROMPT} Expected language: ${hint} (if the speech is in another language, keep that language).`
      : TRANSCRIBE_PROMPT;
    const res = await this.run({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { text: instruction },
            { inline_data: { mime_type: req.mimeType, data: req.audio.toString('base64') } },
          ],
        },
      ],
      // Dedicated *-transcribe models take no thinking config (reasoning.ts returns undefined for them).
      effort: 'low',
      timeoutMs: req.timeoutMs,
      label: 'transcribe',
      allowEmpty: true,
    });
    if (!res.text.trim()) {
      // Let the router try the next target instead of reporting "no speech" from a model that ignored the audio.
      throw new AIProviderError(`empty transcript from ${model}`, 'gemini', 'EMPTY', { retryable: false });
    }
    return {
      text: res.text.trim(),
      usage: res.usage,
      provider: 'gemini',
      model,
      latencyMs: Math.round(nowMs() - started),
    };
  }

  async synthesizeSpeech(req: SpeechRequest): Promise<SpeechResult> {
    const started = nowMs();
    const model = stripModelsPrefix(req.model || GEMINI_DEFAULT_TTS_MODEL);
    const res = await this.post(
      model,
      {
        contents: [{ role: 'user', parts: [{ text: req.text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: resolveGeminiVoice(req.voice) } } },
        },
      },
      req.timeoutMs,
      'tts',
    );
    const parts = res.candidates?.[0]?.content?.parts ?? [];
    let data: string | undefined;
    let mime: string | undefined;
    for (const p of parts) {
      const inline = p.inlineData ?? (p.inline_data ? { mimeType: p.inline_data.mime_type, data: p.inline_data.data } : undefined);
      if (inline?.data) {
        data = inline.data;
        mime = inline.mimeType;
        break;
      }
    }
    if (!data) {
      const finish = res.candidates?.[0]?.finishReason;
      if (res.promptFeedback?.blockReason || (finish && SAFETY_FINISH.has(finish))) {
        throw new AIProviderError('gemini: speech blocked by safety filters', 'gemini', 'SAFETY');
      }
      throw new AIProviderError('gemini: TTS response contained no audio', 'gemini', 'EMPTY', { retryable: false });
    }
    const rate = mime ? /rate=(\d+)/i.exec(mime)?.[1] : undefined;
    return {
      audio: Buffer.from(data, 'base64'),
      format: 'pcm16',
      sampleRate: rate ? Number(rate) : 24_000,
      usage: usageOf(res),
      provider: 'gemini',
      model,
      latencyMs: Math.round(nowMs() - started),
    };
  }

  // ── internals ──

  private post(model: string, body: Record<string, unknown>, timeoutMs: number | undefined, label: string): Promise<GeminiResponse> {
    if (!this.apiKey) throw new AIProviderError('gemini: GEMINI_API_KEY is not set', 'gemini', 'NOT_CONFIGURED');
    return requestJson<GeminiResponse>({
      provider: 'gemini',
      url: `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
      method: 'POST',
      headers: { 'x-goog-api-key': this.apiKey },
      json: body,
      timeoutMs: timeoutMs ?? this.timeoutMs,
      label,
    });
  }

  private async run(p: RunParams): Promise<RunResult> {
    const gemma = p.model.toLowerCase().startsWith('gemma-');
    let system = p.system?.trim() || undefined;
    let contents = p.contents;
    if (contents.length === 0) throw new AIProviderError('gemini: request has no content', 'gemini', 'BAD_REQUEST');
    // Gemma on the Gemini API has neither system instructions nor JSON mode: inline both into the first user turn.
    if (gemma) {
      const preamble = [system, p.json ? jsonSchemaInstruction(p.json.schema) : undefined].filter(Boolean).join('\n\n');
      if (preamble) {
        const [first, ...rest] = contents;
        contents = first ? [{ role: first.role, parts: [{ text: preamble }, ...first.parts] }, ...rest] : contents;
      }
      system = undefined;
    }

    const overrideKey = `${p.model}|${p.effort ?? ''}`;
    const learned = this.thinkingOverrides.get(overrideKey);
    let thinking: GeminiThinkingConfig | undefined =
      learned === null ? undefined : (learned ?? geminiThinkingConfig(p.model, p.effort));
    let triedLow = false;
    let droppedThinking = false;

    for (;;) {
      const generationConfig: Record<string, unknown> = {};
      if (p.maxOutputTokens !== undefined) {
        const allowance = thinking
          ? 'thinkingBudget' in thinking
            ? thinking.thinkingBudget
            : reasoningTokenAllowance(thinking.thinkingLevel)
          : 0;
        generationConfig.maxOutputTokens = Math.min(MAX_OUTPUT_CAP, p.maxOutputTokens + allowance);
      }
      if (p.temperature !== undefined) generationConfig.temperature = p.temperature;
      if (thinking) generationConfig.thinkingConfig = thinking;
      if (p.json && !gemma) {
        generationConfig.responseMimeType = 'application/json';
        generationConfig.responseJsonSchema = p.json.schema;
      }
      const body: Record<string, unknown> = { contents };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

      try {
        const res = await this.post(p.model, body, p.timeoutMs, p.label);
        return this.parse(res, p);
      } catch (error) {
        if (thinking && isBadRequestMatching(error, /thinking/i)) {
          // Verified: gemini-3.8-flash → 400 "Thinking level MINIMAL is not supported for this model".
          if (!triedLow && 'thinkingLevel' in thinking && thinking.thinkingLevel === 'minimal' && /minimal/i.test(error.message)) {
            triedLow = true;
            thinking = { thinkingLevel: 'low' };
            this.thinkingOverrides.set(overrideKey, thinking);
            log.debug({ model: p.model }, 'thinking level minimal unsupported; retrying with low');
            continue;
          }
          if (!droppedThinking) {
            droppedThinking = true;
            thinking = undefined;
            this.thinkingOverrides.set(overrideKey, null);
            log.debug({ model: p.model }, 'thinking config rejected; retrying without it');
            continue;
          }
        }
        throw error;
      }
    }
  }

  private parse(res: GeminiResponse, p: RunParams): RunResult {
    const candidate = res.candidates?.[0];
    if (!candidate) {
      if (res.promptFeedback?.blockReason) {
        throw new AIProviderError(`gemini: prompt blocked (${res.promptFeedback.blockReason})`, 'gemini', 'SAFETY');
      }
      throw new AIProviderError('gemini: response has no candidates', 'gemini', 'EMPTY', { retryable: false });
    }
    const finishReason = candidate.finishReason;
    if (finishReason && SAFETY_FINISH.has(finishReason)) {
      throw new AIProviderError(`gemini: response blocked (${finishReason})`, 'gemini', 'SAFETY');
    }
    const text = (candidate.content?.parts ?? [])
      .filter((part) => part.thought !== true && typeof part.text === 'string')
      .map((part) => part.text ?? '')
      .join('');
    if (!text.trim() && !p.allowEmpty) {
      throw new AIProviderError(`gemini: empty response (finishReason ${finishReason ?? 'unknown'})`, 'gemini', 'EMPTY', {
        retryable: false,
      });
    }
    return {
      text: p.json ? requireJsonObject('gemini', text) : text,
      usage: usageOf(res),
      finishReason,
    };
  }
}
