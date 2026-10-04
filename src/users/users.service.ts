import type { AuditService } from '../audit/audit.service.js';
import type { Db } from '../database/client.js';
import type { TelegramUser, UserMode } from '../generated/prisma/client.js';
import { normalizeTag } from '../rules/rules.engine.js';
import type { RulesService } from '../rules/rules.service.js';

export interface UserSummary {
  user: TelegramUser;
  mode: UserMode | null;
}

/** Contacts seen through the business connection (admin "👤 Users"). */
export class UsersService {
  constructor(
    private readonly db: Db,
    private readonly rules: RulesService,
    private readonly audit: AuditService,
  ) {}

  async list(take: number, skip: number): Promise<{ items: UserSummary[]; total: number }> {
    const [users, total] = await Promise.all([
      this.db.telegramUser.findMany({ orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }], take, skip }),
      this.db.telegramUser.count(),
    ]);
    return { items: await this.withModes(users), total };
  }

  /** Search by @username, (part of) name, or numeric Telegram id. */
  async search(query: string, take = 10): Promise<UserSummary[]> {
    const q = query.trim().replace(/^@/, '');
    if (!q) return [];
    const or: object[] = [
      { username: { contains: q, mode: 'insensitive' } },
      { firstName: { contains: q, mode: 'insensitive' } },
      { lastName: { contains: q, mode: 'insensitive' } },
    ];
    if (/^\d{1,20}$/.test(q)) or.push({ telegramUserId: BigInt(q) });
    const users = await this.db.telegramUser.findMany({
      where: { OR: or as never },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }],
      take,
    });
    return this.withModes(users);
  }

  async byTelegramId(telegramUserId: bigint): Promise<UserSummary | null> {
    const user = await this.db.telegramUser.findUnique({ where: { telegramUserId } });
    if (!user) return null;
    return { user, mode: await this.rules.userMode(telegramUserId) };
  }

  async setMode(telegramUserId: bigint, mode: UserMode, adminTelegramUserId: bigint): Promise<void> {
    await this.rules.setRule('USER_ID', telegramUserId.toString(), mode, adminTelegramUserId);
  }

  async clearMode(telegramUserId: bigint, adminTelegramUserId: bigint): Promise<void> {
    await this.rules.removeRule('USER_ID', telegramUserId.toString(), adminTelegramUserId);
  }

  async setTags(telegramUserId: bigint, tags: string[], adminTelegramUserId: bigint): Promise<string[]> {
    const clean = [...new Set(tags.map((t) => normalizeTag(t)).filter((t): t is string => !!t))].slice(0, 10);
    await this.db.telegramUser.update({ where: { telegramUserId }, data: { tags: clean } });
    this.rules.invalidate();
    await this.audit.record(adminTelegramUserId, 'USER_RULE_CHANGED', `tags:${telegramUserId}`, { tags: clean.join(',') });
    return clean;
  }

  private async withModes(users: TelegramUser[]): Promise<UserSummary[]> {
    if (users.length === 0) return [];
    const rules = await this.db.userRule.findMany({
      where: { matchType: 'USER_ID', matchValue: { in: users.map((u) => u.telegramUserId.toString()) } },
    });
    const byId = new Map(rules.map((r) => [r.matchValue, r.mode]));
    return users.map((user) => ({ user, mode: byId.get(user.telegramUserId.toString()) ?? null }));
  }
}
