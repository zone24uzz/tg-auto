/**
 * Default AiRouter: resolves provider/model targets per operation from runtime settings,
 * walks the fallback chain, enforces the global per-minute AI limit and records usage for
 * every attempt (success or failure).
 */
import { childLogger } from '../../logging/logger.js';
import { describeError } from '../../logging/sanitize.js';
import type { Settings } from '../../settings/schema.js';
import type { UsageRecorder } from '../../statistics/usage.service.js';
import type { PricingTable } from '../pricing.js';
import { defaultPricing } from '../pricing.js';
import { anthropicReasoningParams, geminiThinkingConfig, openAiReasoningParams } from '../reasoning.js';
import type { ProviderRegistry } from '../registry.js';
import { modelMatchesProvider } from '../registry.js';
import type {
  AIProvider,
  AiOperation,
  AnalyzeImageRequest,
  AnalyzeVideoContextRequest,
  ChatTurn,
  GenerateTextRequest,
  GenerateTextResult,
  ProviderCapabilities,
  ProviderId,
  ReasoningEffort,
  SpeechRequest,
  SpeechResult,
  TranscribeRequest,
  TranscribeResult,
} from '../types.js';
import { AIProviderError, AllProvidersFailedError } from '../types.js';
import { GlobalLimiter } from './global-limiter.js';
import type { AiCallContext, AiRouter, RoutedResult } from './types.js';

const log = childLogger('ai-router');
/** Longest time a rate-limited model is skipped (daily quotas reset within a day). */
const MAX_COOLDOWN_MS = 12 * 3_600_000;

export interface AiRouterDeps {
  registry: Pick<ProviderRegistry, 'get' | 'configured' | 'defaultTranscriptionModel' | 'defaultTtsModel'>;
  settings: { get(): Promise<Settings> };
  usage: UsageRecorder;
  limiter?: GlobalLimiter;
  /** Default per-request timeout (AI_REQUEST_TIMEOUT_MS) unless the request sets one. */
  timeoutMs: number;
  /** Defaults to the process-wide table configured from AI_PRICING_JSON. */
  pricing?: PricingTable;
}

interface Target {
  provider: AIProvider;
  model: string;
}

interface Metering {
  inputTokens: number;
  outputTokens: number;
  latencyMs?: number;
  audioSeconds?: number;
}

type Capability = keyof ProviderCapabilities;

function hasImages(turns: ChatTurn[]): boolean {
  return turns.some((t) => t.parts.some((p) => p.type === 'image'));
}

function countImages(turns: ChatTurn[]): number {
  return turns.reduce((n, t) => n + t.parts.filter((p) => p.type === 'image').length, 0);
}

function textMetering(r: GenerateTextResult): Metering {
  return { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, latencyMs: r.latencyMs };
}

/** The effort a provider will actually send for this model (undefined when not supported). */
export function effectiveEffort(
  provider: AIProvider,
  model: string,
  effort: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (!effort) return undefined;
  switch (provider.id) {
    case 'gemini': {
      const cfg = geminiThinkingConfig(model, effort);
      return cfg ? effort : undefined;
    }
    case 'openai':
      return openAiReasoningParams(model, effort)?.reasoning.effort;
    case 'anthropic':
      return anthropicReasoningParams(model, effort, 1024)?.effort;
    case 'openai_compat':
      return provider.capabilities(model).reasoning ? effort : undefined;
  }
}

export class DefaultAiRouter implements AiRouter {
  private readonly registry: AiRouterDeps['registry'];
  private readonly settings: AiRouterDeps['settings'];
  private readonly usage: UsageRecorder;
  private readonly limiter: GlobalLimiter;
  private readonly timeoutMs: number;
  private readonly pricing: PricingTable;

  constructor(deps: AiRouterDeps) {
    this.registry = deps.registry;
    this.settings = deps.settings;
    this.usage = deps.usage;
    this.limiter = deps.limiter ?? new GlobalLimiter();
    this.timeoutMs = deps.timeoutMs;
    this.pricing = deps.pricing ?? defaultPricing;
  }

  // ───────────────────────── operations ─────────────────────────

  async generateReply(req: Omit<GenerateTextRequest, 'model'>, ctx?: AiCallContext): Promise<RoutedResult<GenerateTextResult>> {
    const s = await this.settings.get();
    const effort = req.reasoningEffort ?? s.reasoningEffort;
    const targets = this.usable(this.replyTargets(s), hasImages(req.messages) ? 'vision' : 'text');
    return this.run('TEXT', s, targets, ctx, countImages(req.messages), (t) =>
      this.textCall(t, req, effort).then((r) => ({ result: r, metering: textMetering(r), effort })),
    );
  }

  async summarize(req: Omit<GenerateTextRequest, 'model'>, ctx?: AiCallContext): Promise<RoutedResult<GenerateTextResult>> {
    const s = await this.settings.get();
    const effort = req.reasoningEffort ?? 'low';
    const targets = this.usable(this.replyTargets(s), 'text');
    return this.run('SUMMARY', s, targets, ctx, 0, (t) =>
      this.textCall(t, req, effort).then((r) => ({ result: r, metering: textMetering(r), effort })),
    );
  }

  async classify(req: Omit<GenerateTextRequest, 'model'>, ctx?: AiCallContext): Promise<RoutedResult<GenerateTextResult>> {
    if (!req.json) throw new TypeError('AiRouter.classify requires a JSON output spec (req.json)');
    const s = await this.settings.get();
    const effort = req.reasoningEffort ?? 'low';
    const targets = this.usable(
      [this.target(s.classifierProvider ?? s.aiProvider, s.classifierModel ?? s.aiModel), ...this.replyTargets(s)],
      'text',
    );
    return this.run('CLASSIFY', s, targets, ctx, 0, (t) =>
      this.textCall(t, req, effort).then((r) => ({ result: r, metering: textMetering(r), effort })),
    );
  }

  async analyzeImage(req: Omit<AnalyzeImageRequest, 'model'>, ctx?: AiCallContext): Promise<RoutedResult<GenerateTextResult>> {
    const s = await this.settings.get();
    const effort = req.reasoningEffort ?? s.reasoningEffort;
    const targets = this.usable(this.mediaTargets(s), 'vision');
    return this.run('VISION', s, targets, ctx, req.images.length, (t) =>
      t.provider
        .analyzeImage({ ...req, model: t.model, reasoningEffort: effort, timeoutMs: req.timeoutMs ?? this.timeoutMs })
        .then((r) => ({ result: r, metering: textMetering(r), effort })),
    );
  }

  async analyzeVideo(
    req: Omit<AnalyzeVideoContextRequest, 'model'>,
    ctx?: AiCallContext,
  ): Promise<RoutedResult<GenerateTextResult>> {
    const s = await this.settings.get();
    const effort = req.reasoningEffort ?? s.reasoningEffort;
    const targets = this.usable(this.mediaTargets(s), 'vision');
    return this.run('VIDEO', s, targets, ctx, req.frames.length, (t) =>
      t.provider
        .analyzeVideoContext({ ...req, model: t.model, reasoningEffort: effort, timeoutMs: req.timeoutMs ?? this.timeoutMs })
        .then((r) => ({ result: r, metering: textMetering(r), effort })),
    );
  }

  async transcribe(req: Omit<TranscribeRequest, 'model'>, ctx?: AiCallContext): Promise<RoutedResult<TranscribeResult>> {
    const s = await this.settings.get();
    const targets = this.transcriptionTargets(s);
    return this.run('TRANSCRIBE', s, targets, ctx, 0, (t) =>
      t.provider.transcribeAudio({ ...req, model: t.model, timeoutMs: req.timeoutMs ?? this.timeoutMs }).then((r) => ({
        result: r,
        metering: {
          inputTokens: r.usage.inputTokens,
          outputTokens: r.usage.outputTokens,
          latencyMs: r.latencyMs,
          audioSeconds: r.durationSec,
        },
        effort: undefined,
      })),
    );
  }

  async synthesizeSpeech(req: Omit<SpeechRequest, 'model'>, ctx?: AiCallContext): Promise<RoutedResult<SpeechResult>> {
    const s = await this.settings.get();
    const voice = req.voice ?? s.ttsVoice ?? undefined;
    const targets = this.ttsTargets(s);
    return this.run('TTS', s, targets, ctx, 0, (t) => {
      const synth = t.provider.synthesizeSpeech;
      if (!synth) {
        return Promise.reject(new AIProviderError(`${t.provider.id}: TTS is not supported`, t.provider.id, 'UNSUPPORTED'));
      }
      return synth
        .call(t.provider, { ...req, model: t.model, voice, timeoutMs: req.timeoutMs ?? this.timeoutMs })
        .then((r) => ({
          result: r,
          metering: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, latencyMs: r.latencyMs },
          effort: undefined,
        }));
    });
  }

  async canTranscribe(): Promise<boolean> {
    return this.transcriptionTargets(await this.settings.get()).length > 0;
  }

  async canSynthesizeSpeech(): Promise<boolean> {
    return this.ttsTargets(await this.settings.get()).length > 0;
  }

  // ───────────────────────── target resolution ─────────────────────────

  /** A configured target, or undefined when the provider is missing/unconfigured or the model belongs to another provider. */
  private target(providerId: ProviderId | null | undefined, model: string | null | undefined): Target | undefined {
    if (!providerId || !model) return undefined;
    const provider = this.registry.get(providerId);
    if (!provider || !provider.isConfigured()) return undefined;
    if (!modelMatchesProvider(providerId, model)) {
      log.debug({ provider: providerId, model }, 'skipping target: model belongs to another provider');
      return undefined;
    }
    return { provider, model };
  }

  private replyTargets(s: Settings): Array<Target | undefined> {
    return [
      this.target(s.aiProvider, s.aiModel),
      this.target(s.fallbackProvider ?? (s.fallbackModel ? s.aiProvider : null), s.fallbackModel),
    ];
  }

  private mediaTargets(s: Settings): Array<Target | undefined> {
    return [this.target(s.mediaProvider ?? s.aiProvider, s.mediaModel ?? s.aiModel), ...this.replyTargets(s)];
  }

  private transcriptionTargets(s: Settings): Target[] {
    const primaryId = s.transcriptionProvider ?? s.aiProvider;
    const defaultModel = this.registry.defaultTranscriptionModel(primaryId);
    const configured = s.transcriptionModel;
    const primaryModel = configured && modelMatchesProvider(primaryId, configured) ? configured : defaultModel;
    const list: Array<Target | undefined> = [this.target(primaryId, primaryModel)];
    for (const p of this.registry.configured()) list.push(this.target(p.id, this.registry.defaultTranscriptionModel(p.id)));
    // Gemini chat models are natively multimodal, so the reply chain doubles as a transcription fallback.
    for (const t of this.replyTargets(s)) if (t?.provider.id === 'gemini') list.push(t);
    return this.usable(list, 'audioTranscription');
  }

  private ttsTargets(s: Settings): Target[] {
    const list: Array<Target | undefined> = [];
    const configured = this.registry.configured();
    if (s.ttsProvider) {
      const model = s.ttsModel && modelMatchesProvider(s.ttsProvider, s.ttsModel) ? s.ttsModel : this.registry.defaultTtsModel(s.ttsProvider);
      list.push(this.target(s.ttsProvider, model));
    } else if (s.ttsModel) {
      for (const p of configured) list.push(this.target(p.id, s.ttsModel));
    }
    for (const p of configured) list.push(this.target(p.id, this.registry.defaultTtsModel(p.id)));
    return this.usable(list, 'tts').filter((t) => typeof t.provider.synthesizeSpeech === 'function');
  }

  /** Drops missing targets, dedupes provider+model pairs and keeps only capability-matching ones. */
  private usable(targets: Array<Target | undefined>, need: Capability): Target[] {
    const seen = new Set<string>();
    const out: Target[] = [];
    for (const t of targets) {
      if (!t) continue;
      const key = `${t.provider.id}|${t.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!t.provider.capabilities(t.model)[need]) continue;
      out.push(t);
    }
    return out;
  }

  // ───────────────────────── execution ─────────────────────────

  private textCall(t: Target, req: Omit<GenerateTextRequest, 'model'>, effort: ReasoningEffort): Promise<GenerateTextResult> {
    return t.provider.generateText({ ...req, model: t.model, reasoningEffort: effort, timeoutMs: req.timeoutMs ?? this.timeoutMs });
  }

  /**
   * Models that answered 429 (per provider instance, i.e. per API key): skipped until the provider's
   * retry delay passes, so an exhausted daily quota (e.g. 20 requests/day on a free tier) does not cost
   * a failed call + latency on every message. When every target is cooling down, all are tried anyway.
   */
  private readonly cooling = new WeakMap<object, Map<string, number>>();

  private coolingUntil(t: Target): number {
    return this.cooling.get(t.provider)?.get(t.model) ?? 0;
  }

  private coolDown(t: Target, error: unknown): void {
    if (!(error instanceof AIProviderError) || error.code !== 'RATE_LIMIT') return;
    const ms = Math.min(error.options.cooldownMs ?? (error.options.quotaExhausted ? 15 * 60_000 : 60_000), MAX_COOLDOWN_MS);
    let byModel = this.cooling.get(t.provider);
    if (!byModel) this.cooling.set(t.provider, (byModel = new Map()));
    byModel.set(t.model, Date.now() + ms);
    log.warn({ provider: t.provider.id, model: t.model, cooldownSec: Math.round(ms / 1000), quotaExhausted: error.options.quotaExhausted ?? false }, 'model rate-limited; skipping it for a while');
  }

  private async run<T>(
    operation: AiOperation,
    settings: Settings,
    allTargets: Target[],
    ctx: AiCallContext | undefined,
    imageCount: number,
    call: (t: Target) => Promise<{ result: T; metering: Metering; effort: ReasoningEffort | undefined }>,
  ): Promise<RoutedResult<T>> {
    const attempts: Array<{ provider: ProviderId; model: string; error: string }> = [];
    const now = Date.now();
    const live = allTargets.filter((t) => this.coolingUntil(t) <= now);
    const targets = live.length > 0 ? live : allTargets;
    for (const [index, t] of targets.entries()) {
      if (!this.limiter.tryAcquire(settings.globalAiRequestsPerMinute)) {
        attempts.push({ provider: t.provider.id, model: t.model, error: 'global AI requests-per-minute limit reached' });
        log.warn({ operation, limit: settings.globalAiRequestsPerMinute }, 'global AI rate limit reached; not calling provider');
        throw new AllProvidersFailedError(operation, attempts);
      }
      const started = performance.now();
      try {
        const { result, metering, effort } = await call(t);
        const costUsd = this.pricing.estimate({
          provider: t.provider.id,
          model: t.model,
          inputTokens: metering.inputTokens,
          outputTokens: metering.outputTokens,
          audioSeconds: metering.audioSeconds,
        });
        await this.record({
          provider: t.provider.id,
          model: t.model,
          operation,
          inputTokens: metering.inputTokens,
          outputTokens: metering.outputTokens,
          ...(metering.audioSeconds !== undefined ? { audioSeconds: metering.audioSeconds } : {}),
          ...(imageCount > 0 ? { imageCount } : {}),
          costUsd,
          latencyMs: metering.latencyMs ?? Math.round(performance.now() - started),
          success: true,
          ...(ctx?.messageId !== undefined ? { messageId: ctx.messageId } : {}),
        });
        const reasoningEffort = effectiveEffort(t.provider, t.model, effort);
        return {
          result,
          provider: t.provider.id,
          model: t.model,
          usedFallback: t !== allTargets[0],
          costUsd,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        };
      } catch (error) {
        const message = describeError(error, 300);
        attempts.push({ provider: t.provider.id, model: t.model, error: message });
        this.coolDown(t, error);
        log.warn(
          {
            operation,
            provider: t.provider.id,
            model: t.model,
            code: error instanceof AIProviderError ? error.code : undefined,
            status: error instanceof AIProviderError ? error.options.status : undefined,
            next: index + 1 < targets.length,
          },
          'AI attempt failed',
        );
        await this.record({
          provider: t.provider.id,
          model: t.model,
          operation,
          latencyMs: Math.round(performance.now() - started),
          success: false,
          ...(ctx?.messageId !== undefined ? { messageId: ctx.messageId } : {}),
        });
      }
    }
    if (allTargets.length === 0) log.warn({ operation }, 'no configured AI provider/model can handle this operation');
    throw new AllProvidersFailedError(operation, attempts);
  }

  private async record(entry: Parameters<UsageRecorder['record']>[0]): Promise<void> {
    try {
      await this.usage.record(entry);
    } catch (error) {
      log.error({ err: describeError(error) }, 'usage recording failed');
    }
  }
}
