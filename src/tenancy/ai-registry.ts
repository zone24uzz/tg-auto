import { createHash } from 'node:crypto';
import { ProviderRegistry, type RegistryEnv } from '../ai/registry.js';
import type { AIProvider, ModelInfo, ProviderId } from '../ai/types.js';
import type { ContentCipher } from '../security/crypto.js';
import { currentTenantOrNull } from './context.js';

const KEY_ENV: Record<string, 'GEMINI_API_KEY' | 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY'> = {
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

/**
 * A ProviderRegistry that answers for the CURRENT workspace:
 *  - the super-admin's workspace (and system work) uses the deployment's keys from env;
 *  - every other workspace uses only the key its owner brought during onboarding — never the
 *    deployment's keys (no free riding on the owner's quota). Without a key nothing is configured.
 * Per-workspace registries are cached by key fingerprint, so provider instances (and the router's
 * per-provider rate-limit cool-downs) are per key.
 */
export class TenantProviderRegistry extends ProviderRegistry {
  private readonly cache = new Map<string, ProviderRegistry>();
  private readonly noKeys: ProviderRegistry;

  constructor(
    private readonly shared: ProviderRegistry,
    private readonly env: RegistryEnv,
    private readonly cipher: ContentCipher,
    private readonly superAdminId: bigint,
  ) {
    super([]);
    this.noKeys = ProviderRegistry.fromEnv(this.keyless());
  }

  private keyless(): RegistryEnv {
    return { ...this.env, GEMINI_API_KEY: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, OPENAI_COMPAT_API_KEY: undefined, OPENAI_COMPAT_BASE_URL: undefined };
  }

  /** The registry of the workspace the current unit of work belongs to. */
  current(): ProviderRegistry {
    const tenant = currentTenantOrNull();
    if (!tenant) return this.shared;
    const ai = tenant.ai;
    if (!ai?.keyEnc || !ai.provider || !KEY_ENV[ai.provider]) return tenant.ownerTelegramUserId === this.superAdminId ? this.shared : this.noKeys;
    const cacheKey = `${tenant.tenantId}:${ai.provider}:${createHash('sha256').update(ai.keyEnc).digest('hex').slice(0, 16)}`;
    let registry = this.cache.get(cacheKey);
    if (!registry) {
      const key = this.cipher.decrypt(ai.keyEnc);
      // "[encrypted]" / "[unreadable]" = the encryption key is missing or changed: never use a placeholder as a key.
      if (!key || key === '[encrypted]' || key === '[unreadable]') return this.noKeys;
      // fromEnv registers the key with the log sanitizer.
      registry = ProviderRegistry.fromEnv({ ...this.keyless(), [KEY_ENV[ai.provider]!]: key });
      for (const old of [...this.cache.keys()]) if (old.startsWith(`${tenant.tenantId}:`)) this.cache.delete(old);
      this.cache.set(cacheKey, registry);
    }
    return registry;
  }

  override get(id: ProviderId): AIProvider | undefined {
    return this.current().get(id);
  }

  override all(): AIProvider[] {
    return this.current().all();
  }

  override configured(): AIProvider[] {
    return this.current().configured();
  }

  override isConfigured(id: ProviderId): boolean {
    return this.current().isConfigured(id);
  }

  override listModels(id: ProviderId): Promise<ModelInfo[]> {
    return this.current().listModels(id);
  }

  override defaultTranscriptionModel(id: ProviderId): string | undefined {
    return this.current().defaultTranscriptionModel(id);
  }

  override defaultTtsModel(id: ProviderId): string | undefined {
    return this.current().defaultTtsModel(id);
  }
}
