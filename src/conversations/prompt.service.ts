import type { AuditService } from '../audit/audit.service.js';
import { defaultOwnerPrompt } from '../config/defaults.js';
import type { Db } from '../database/client.js';
import { currentTenantId } from '../tenancy/context.js';
import { isUniqueViolation } from '../messages/message.repository.js';

const KIND = 'SYSTEM';
export const MAX_PROMPT_LENGTH = 6000;

export class PromptValidationError extends Error {}

/** Versioned owner prompt (the editable part of the system instructions). */
export class PromptService {
  /** Per-tenant cache of the active prompt. */
  private readonly cache = new Map<number, { content: string; version: number; at: number }>();

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly ownerName: () => Promise<string>,
  ) {}

  async getActive(): Promise<{ content: string; version: number }> {
    const tenantId = currentTenantId('prompt');
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < 5_000) return { content: hit.content, version: hit.version };
    let active = await this.db.prompt.findFirst({ where: { kind: KIND, isActive: true }, orderBy: { version: 'desc' } });
    if (!active) {
      try {
        active = await this.db.prompt.create({
          data: { kind: KIND, version: 1, content: defaultOwnerPrompt(await this.ownerName()), isActive: true },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        active = await this.db.prompt.findFirstOrThrow({ where: { kind: KIND }, orderBy: { version: 'desc' } });
      }
    }
    this.cache.set(tenantId, { content: active.content, version: active.version, at: Date.now() });
    return { content: active.content, version: active.version };
  }

  async list(take = 10, skip = 0) {
    const [items, total] = await Promise.all([
      this.db.prompt.findMany({ where: { kind: KIND }, orderBy: { version: 'desc' }, take, skip }),
      this.db.prompt.count({ where: { kind: KIND } }),
    ]);
    return { items, total };
  }

  async getVersion(version: number) {
    return this.db.prompt.findUnique({ where: { tenantId_kind_version: { tenantId: currentTenantId(), kind: KIND, version } } });
  }

  validate(content: string): string {
    const trimmed = content.replace(/\r\n/g, '\n').trim();
    if (trimmed.length < 10) throw new PromptValidationError('Prompt juda qisqa (kamida 10 belgi).');
    if (trimmed.length > MAX_PROMPT_LENGTH) throw new PromptValidationError(`Prompt juda uzun (maks. ${MAX_PROMPT_LENGTH} belgi).`);
    return trimmed;
  }

  /** Saves a new version and makes it active. */
  async update(content: string, adminTelegramUserId: bigint): Promise<number> {
    const valid = this.validate(content);
    await this.getActive();
    const version = await this.db.$transaction(async (tx) => {
      const last = await tx.prompt.findFirst({ where: { kind: KIND }, orderBy: { version: 'desc' } });
      const next = (last?.version ?? 0) + 1;
      await tx.prompt.updateMany({ where: { kind: KIND, isActive: true }, data: { isActive: false } });
      await tx.prompt.create({ data: { kind: KIND, version: next, content: valid, isActive: true, createdBy: adminTelegramUserId } });
      return next;
    });
    this.cache.clear();
    await this.audit.record(adminTelegramUserId, 'PROMPT_CHANGED', `prompt:v${version}`, { length: valid.length });
    return version;
  }

  /** Re-activates an older version (as a new version, so history stays linear). */
  async restore(version: number, adminTelegramUserId: bigint): Promise<number> {
    const old = await this.getVersion(version);
    if (!old) throw new PromptValidationError('Bunday versiya topilmadi.');
    const newVersion = await this.update(old.content, adminTelegramUserId);
    await this.audit.record(adminTelegramUserId, 'PROMPT_RESTORED', `prompt:v${version}`, { newVersion });
    return newVersion;
  }

  async resetDefault(adminTelegramUserId: bigint): Promise<number> {
    const newVersion = await this.update(defaultOwnerPrompt(await this.ownerName()), adminTelegramUserId);
    await this.audit.record(adminTelegramUserId, 'PROMPT_RESET', `prompt:v${newVersion}`);
    return newVersion;
  }
}
