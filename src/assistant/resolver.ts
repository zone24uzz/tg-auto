import type { ResolvedTelegramUser, UserbotAssistantApi } from '../app/userbot-contract.js';
import type { Db } from '../database/client.js';
import type { TelegramUser } from '../generated/prisma/client.js';

export interface PersonCandidate {
  telegramUserId: bigint;
  label: string;
}

export type ResolveResult =
  | { status: 'one'; person: PersonCandidate }
  | { status: 'many'; candidates: PersonCandidate[] }
  | { status: 'none' };

const USERNAME_RE = /^@?[A-Za-z][A-Za-z0-9_]{3,31}$/;
const MAX_CANDIDATES = 6;

export function personLabel(u: { username?: string | null; firstName?: string | null; lastName?: string | null; telegramUserId?: bigint }): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  if (name && u.username) return `${name} (@${u.username})`;
  if (name) return name;
  if (u.username) return `@${u.username}`;
  return u.telegramUserId !== undefined ? `id ${u.telegramUserId}` : 'noma’lum';
}

function fromRow(u: TelegramUser): PersonCandidate {
  return { telegramUserId: u.telegramUserId, label: personLabel(u) };
}

/**
 * Finds the person the owner means: numeric id → @username → people who wrote to the owner
 * (local DB) → the owner's Telegram contacts/chats (userbot) → public @username lookup.
 * People found through Telegram are saved to `users` (with access hash) so tasks can act on them.
 */
export class PersonResolver {
  constructor(
    private readonly db: Db,
    private readonly userbot: () => UserbotAssistantApi | null,
  ) {}

  async resolve(query: string): Promise<ResolveResult> {
    const q = query.trim();
    if (!q) return { status: 'none' };

    if (/^\d{5,20}$/.test(q)) {
      const id = BigInt(q);
      const row = await this.db.telegramUser.findUnique({ where: { telegramUserId: id } });
      return { status: 'one', person: row ? fromRow(row) : { telegramUserId: id, label: `id ${q}` } };
    }

    const looksLikeUsername = USERNAME_RE.test(q) && (q.startsWith('@') || /_|\d/.test(q));
    if (q.startsWith('@') || looksLikeUsername) {
      const username = q.replace(/^@/, '');
      const row = await this.db.telegramUser.findFirst({ where: { username: { equals: username, mode: 'insensitive' } } });
      if (row) return { status: 'one', person: fromRow(row) };
      const resolved = await this.userbot()?.resolveUsername(username);
      if (resolved) return { status: 'one', person: await this.remember(resolved) };
      if (q.startsWith('@')) return { status: 'none' };
    }

    // Names: people who wrote to the owner first (most recent first).
    const rows = await this.db.telegramUser.findMany({
      where: {
        isBot: false,
        OR: [
          { firstName: { contains: q, mode: 'insensitive' } },
          { lastName: { contains: q, mode: 'insensitive' } },
          { username: { contains: q.replace(/^@/, ''), mode: 'insensitive' } },
        ],
      },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }],
      take: MAX_CANDIDATES,
    });
    const exact = rows.filter((r) => [r.firstName, [r.firstName, r.lastName].filter(Boolean).join(' ')].some((n) => n?.toLowerCase() === q.toLowerCase()));
    if (exact.length === 1) return { status: 'one', person: fromRow(exact[0]!) };
    if (rows.length === 1) return { status: 'one', person: fromRow(rows[0]!) };

    // Then the owner's own Telegram contacts / chats.
    const found = (await this.userbot()?.searchPeople(q, MAX_CANDIDATES)) ?? [];
    const merged = new Map<bigint, PersonCandidate>(rows.map((r) => [r.telegramUserId, fromRow(r)]));
    for (const person of found) if (!merged.has(person.id)) merged.set(person.id, await this.remember(person));
    const candidates = [...merged.values()].slice(0, MAX_CANDIDATES);
    if (candidates.length === 0) return { status: 'none' };
    if (candidates.length === 1) return { status: 'one', person: candidates[0]! };
    return { status: 'many', candidates };
  }

  /** Stores a person found through Telegram so later tasks can address them (access hash). */
  private async remember(user: ResolvedTelegramUser): Promise<PersonCandidate> {
    const data = {
      username: user.username ?? null,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      isBot: user.isBot ?? false,
      ...(user.accessHash ? { accessHash: user.accessHash } : {}),
      ...(user.isContact !== undefined ? { isContact: user.isContact } : {}),
    };
    const row = await this.db.telegramUser.upsert({
      where: { telegramUserId: user.id },
      create: { telegramUserId: user.id, ...data },
      update: data,
    });
    return fromRow(row);
  }
}
