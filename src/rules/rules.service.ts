import type { AuditService } from '../audit/audit.service.js';
import type { Db } from '../database/client.js';
import type { RuleMatchType, UserMode } from '../generated/prisma/client.js';
import { normalizeTag, normalizeUsername, type RuleRecord } from './rules.engine.js';

const CACHE_TTL_MS = 5_000;

export class RuleValidationError extends Error {}

/** Normalizes a rule value for storage; throws RuleValidationError when invalid. */
export function normalizeRuleValue(matchType: RuleMatchType, raw: string): string {
  const value = raw.trim();
  switch (matchType) {
    case 'USER_ID':
    case 'CHAT_ID':
      if (!/^-?\d{1,20}$/.test(value)) throw new RuleValidationError('ID must be numeric');
      return BigInt(value).toString();
    case 'USERNAME': {
      const u = normalizeUsername(value);
      if (!u) throw new RuleValidationError('invalid username');
      return u;
    }
    case 'TAG': {
      const t = normalizeTag(value);
      if (!t) throw new RuleValidationError('invalid tag');
      return t;
    }
    default:
      throw new RuleValidationError('unknown rule type');
  }
}

export class RulesService {
  private cache: { rules: RuleRecord[]; at: number } | null = null;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async all(): Promise<RuleRecord[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.rules;
    const rows = await this.db.userRule.findMany({ select: { matchType: true, matchValue: true, mode: true } });
    this.cache = { rules: rows, at: Date.now() };
    return rows;
  }

  invalidate(): void {
    this.cache = null;
  }

  async list(mode: UserMode | undefined, take: number, skip: number) {
    const where = mode ? { mode } : {};
    const [items, total] = await Promise.all([
      this.db.userRule.findMany({ where, orderBy: { updatedAt: 'desc' }, take, skip }),
      this.db.userRule.count({ where }),
    ]);
    return { items, total };
  }

  async get(matchType: RuleMatchType, rawValue: string) {
    return this.db.userRule.findUnique({
      where: { matchType_matchValue: { matchType, matchValue: normalizeRuleValue(matchType, rawValue) } },
    });
  }

  async setRule(
    matchType: RuleMatchType,
    rawValue: string,
    mode: UserMode,
    adminTelegramUserId: bigint,
    note?: string,
  ): Promise<void> {
    const matchValue = normalizeRuleValue(matchType, rawValue);
    const existing = await this.db.userRule.findUnique({ where: { matchType_matchValue: { matchType, matchValue } } });
    await this.db.userRule.upsert({
      where: { matchType_matchValue: { matchType, matchValue } },
      create: { matchType, matchValue, mode, note: note ?? null },
      update: { mode, ...(note !== undefined ? { note } : {}) },
    });
    this.invalidate();
    const action =
      mode === 'BLOCK' ? 'USER_BLOCKED' : existing?.mode === 'BLOCK' ? 'USER_UNBLOCKED' : 'USER_RULE_CHANGED';
    await this.audit.record(adminTelegramUserId, action, `${matchType}:${matchValue}`, {
      from: existing?.mode ?? null,
      to: mode,
    });
  }

  async removeRule(matchType: RuleMatchType, rawValue: string, adminTelegramUserId: bigint): Promise<boolean> {
    const matchValue = normalizeRuleValue(matchType, rawValue);
    const existing = await this.db.userRule.findUnique({ where: { matchType_matchValue: { matchType, matchValue } } });
    if (!existing) return false;
    await this.db.userRule.delete({ where: { id: existing.id } });
    this.invalidate();
    await this.audit.record(
      adminTelegramUserId,
      existing.mode === 'BLOCK' ? 'USER_UNBLOCKED' : 'USER_RULE_CHANGED',
      `${matchType}:${matchValue}`,
      { from: existing.mode, to: null },
    );
    return true;
  }

  /** Explicit per-user mode (USER_ID rule) or null. */
  async userMode(telegramUserId: bigint): Promise<UserMode | null> {
    const rule = await this.db.userRule.findUnique({
      where: { matchType_matchValue: { matchType: 'USER_ID', matchValue: telegramUserId.toString() } },
    });
    return rule?.mode ?? null;
  }
}
