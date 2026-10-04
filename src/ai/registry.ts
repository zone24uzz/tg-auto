/**
 * Holds one instance per AI provider, built from env (or injected for tests).
 * Unconfigured providers are still registered (so the admin bot can show them) but
 * `configured()` only returns those with credentials / base URL.
 */
import type { Env } from '../config/env.js';
import { registerSecrets } from '../logging/sanitize.js';
import { configurePricing } from './pricing.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { GEMINI_DEFAULT_TRANSCRIPTION_MODEL, GEMINI_DEFAULT_TTS_MODEL, GeminiProvider } from './providers/gemini.js';
import { OPENAI_COMPAT_DEFAULT_TRANSCRIPTION_MODEL, OpenAICompatibleProvider } from './providers/openai-compatible.js';
import { OPENAI_DEFAULT_TRANSCRIPTION_MODEL, OPENAI_DEFAULT_TTS_MODEL, OpenAIProvider } from './providers/openai.js';
import type { AIProvider, ModelInfo, ProviderId } from './types.js';

export type RegistryEnv = Pick<
  Env,
  | 'GEMINI_API_KEY'
  | 'GEMINI_BASE_URL'
  | 'OPENAI_API_KEY'
  | 'OPENAI_BASE_URL'
  | 'ANTHROPIC_API_KEY'
  | 'ANTHROPIC_BASE_URL'
  | 'OPENAI_COMPAT_BASE_URL'
  | 'OPENAI_COMPAT_API_KEY'
  | 'OPENAI_COMPAT_MODELS'
  | 'OPENAI_COMPAT_SUPPORTS_VISION'
  | 'OPENAI_COMPAT_SUPPORTS_REASONING'
  | 'OPENAI_COMPAT_SUPPORTS_TRANSCRIPTION'
  | 'AI_REQUEST_TIMEOUT_MS'
  | 'AI_PRICING_JSON'
>;

const DEFAULT_TRANSCRIPTION_MODELS: Partial<Record<ProviderId, string>> = {
  gemini: GEMINI_DEFAULT_TRANSCRIPTION_MODEL,
  openai: OPENAI_DEFAULT_TRANSCRIPTION_MODEL,
  openai_compat: OPENAI_COMPAT_DEFAULT_TRANSCRIPTION_MODEL,
};

const DEFAULT_TTS_MODELS: Partial<Record<ProviderId, string>> = {
  gemini: GEMINI_DEFAULT_TTS_MODEL,
  openai: OPENAI_DEFAULT_TTS_MODEL,
};

/**
 * False only when the model id clearly belongs to another provider family
 * (e.g. "gemini-3.5-transcribe" on openai). OpenAI-compatible endpoints accept anything.
 */
export function modelMatchesProvider(provider: ProviderId, model: string): boolean {
  const m = model.trim().toLowerCase().replace(/^models\//, '');
  const family: ProviderId | undefined = /^(gemini|gemma)-/.test(m)
    ? 'gemini'
    : /^claude-/.test(m)
      ? 'anthropic'
      : /^(gpt-|o\d|chatgpt-|whisper-|dall-e|tts-)/.test(m)
        ? 'openai'
        : undefined;
  return provider === 'openai_compat' || family === undefined || family === provider;
}

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, AIProvider>();

  constructor(providers: AIProvider[]) {
    for (const p of providers) this.providers.set(p.id, p);
  }

  static fromEnv(env: RegistryEnv): ProviderRegistry {
    registerSecrets([env.GEMINI_API_KEY, env.OPENAI_API_KEY, env.ANTHROPIC_API_KEY, env.OPENAI_COMPAT_API_KEY]);
    configurePricing(env.AI_PRICING_JSON);
    const timeoutMs = env.AI_REQUEST_TIMEOUT_MS;
    return new ProviderRegistry([
      new GeminiProvider({ apiKey: env.GEMINI_API_KEY, baseUrl: env.GEMINI_BASE_URL, timeoutMs }),
      new OpenAIProvider({ apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL, timeoutMs }),
      new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, baseUrl: env.ANTHROPIC_BASE_URL, timeoutMs }),
      new OpenAICompatibleProvider({
        baseUrl: env.OPENAI_COMPAT_BASE_URL,
        apiKey: env.OPENAI_COMPAT_API_KEY,
        models: env.OPENAI_COMPAT_MODELS,
        supportsVision: env.OPENAI_COMPAT_SUPPORTS_VISION,
        supportsReasoning: env.OPENAI_COMPAT_SUPPORTS_REASONING,
        supportsTranscription: env.OPENAI_COMPAT_SUPPORTS_TRANSCRIPTION,
        timeoutMs,
      }),
    ]);
  }

  get(id: ProviderId): AIProvider | undefined {
    return this.providers.get(id);
  }

  all(): AIProvider[] {
    return [...this.providers.values()];
  }

  configured(): AIProvider[] {
    return this.all().filter((p) => p.isConfigured());
  }

  isConfigured(id: ProviderId): boolean {
    return this.providers.get(id)?.isConfigured() ?? false;
  }

  /** Chat models for the admin model picker ([] when the provider is unknown). */
  async listModels(id: ProviderId): Promise<ModelInfo[]> {
    const provider = this.providers.get(id);
    return provider ? provider.listModels() : [];
  }

  defaultTranscriptionModel(id: ProviderId): string | undefined {
    return DEFAULT_TRANSCRIPTION_MODELS[id];
  }

  defaultTtsModel(id: ProviderId): string | undefined {
    return DEFAULT_TTS_MODELS[id];
  }
}

export function createProviderRegistry(env: RegistryEnv): ProviderRegistry {
  return ProviderRegistry.fromEnv(env);
}
