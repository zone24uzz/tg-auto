import type { AuditService } from '../audit/audit.service.js';
import type { Db } from '../database/client.js';
import type { AuditAction } from '../generated/prisma/client.js';
import { childLogger } from '../logging/logger.js';
import { SETTING_KEYS, settingsShape, type SettingKey, type Settings } from './schema.js';

const log = childLogger('settings');
const CACHE_TTL_MS = 5_000;

const MODEL_KEYS = new Set<SettingKey>([
  'aiModel',
  'fallbackModel',
  'mediaModel',
  'transcriptionModel',
  'classifierModel',
  'ttsModel',
]);
const PROVIDER_KEYS = new Set<SettingKey>([
  'aiProvider',
  'fallbackProvider',
  'mediaProvider',
  'transcriptionProvider',
  'classifierProvider',
  'ttsProvider',
]);
/** Internal keys are changed by the system, never audited as admin actions. */
const INTERNAL_KEYS = new Set<SettingKey>(['lastCleanupAt', 'costLimitNotifiedOn']);

export class SettingValidationError extends Error {
  constructor(
    public readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = 'SettingValidationError';
  }
}

function auditActionFor(key: SettingKey, value: unknown): AuditAction {
  if (key === 'autoReplyEnabled') return value ? 'AUTO_REPLY_ENABLED' : 'AUTO_REPLY_DISABLED';
  if (key === 'pausedUntil') return 'AUTO_REPLY_PAUSED';
  if (MODEL_KEYS.has(key)) return 'MODEL_CHANGED';
  if (PROVIDER_KEYS.has(key)) return 'PROVIDER_CHANGED';
  if (key === 'reasoningEffort') return 'REASONING_CHANGED';
  return 'SETTING_CHANGED';
}

/**
 * Typed runtime settings backed by the `settings` table.
 * Reads are cached briefly so the hot path does not hit the DB on every message;
 * a separate worker process sees changes within CACHE_TTL_MS.
 */
export class SettingsService {
  private cache: { value: Settings; at: number } | null = null;

  constructor(
    private readonly db: Db,
    private readonly defaults: Settings,
    private readonly audit: AuditService,
  ) {}

  getDefaults(): Settings {
    return { ...this.defaults };
  }

  async get(): Promise<Settings> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.value;
    const rows = await this.db.setting.findMany();
    const merged: Record<string, unknown> = { ...this.defaults };
    for (const row of rows) {
      if (!(row.key in settingsShape)) continue;
      const key = row.key as SettingKey;
      const parsed = settingsShape[key].safeParse(row.value);
      if (parsed.success) merged[key] = parsed.data;
      else log.warn({ key }, 'stored setting is invalid; using default');
    }
    const value = merged as Settings;
    this.cache = { value, at: Date.now() };
    return value;
  }

  invalidate(): void {
    this.cache = null;
  }

  validate<K extends SettingKey>(key: K, value: unknown): Settings[K] {
    if (!SETTING_KEYS.includes(key)) throw new SettingValidationError(key, 'unknown setting');
    const parsed = settingsShape[key].safeParse(value);
    if (!parsed.success) {
      throw new SettingValidationError(key, parsed.error.issues.map((i) => i.message).join('; '));
    }
    return parsed.data as Settings[K];
  }

  /** Validates, persists and audits a single setting change. */
  async set<K extends SettingKey>(key: K, value: Settings[K], adminTelegramUserId?: bigint): Promise<Settings[K]> {
    const valid = this.validate(key, value);
    const before = (await this.get())[key];
    await this.db.setting.upsert({
      where: { key },
      create: { key, value: valid as never, updatedBy: adminTelegramUserId ?? null },
      update: { value: valid as never, updatedBy: adminTelegramUserId ?? null },
    });
    this.invalidate();
    if (adminTelegramUserId !== undefined && !INTERNAL_KEYS.has(key)) {
      await this.audit.record(adminTelegramUserId, auditActionFor(key, valid), key, {
        from: summarize(before),
        to: summarize(valid),
      });
    }
    return valid;
  }

  /** Restores a key to its default value (deletes the override row). */
  async reset(key: SettingKey, adminTelegramUserId: bigint): Promise<void> {
    await this.db.setting.deleteMany({ where: { key } });
    this.invalidate();
    await this.audit.record(adminTelegramUserId, 'SETTING_CHANGED', key, { reset: true });
  }

  /** True when auto replies are active right now (enabled and not paused). */
  static isAutoReplyActive(settings: Settings, now = new Date()): boolean {
    if (!settings.autoReplyEnabled) return false;
    if (settings.pausedUntil && new Date(settings.pausedUntil).getTime() > now.getTime()) return false;
    return true;
  }
}

function summarize(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 120) return `${value.slice(0, 120)}…`;
  return value;
}
