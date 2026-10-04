import type { Db } from '../../database/client.js';

/** Pending text inputs expire after 15 minutes. */
export const INPUT_TTL_MS = 15 * 60_000;

export type InputPayload = Record<string, string | number>;

export interface PendingInput {
  state: string;
  payload: InputPayload;
  expiresAt: Date;
}

function toPayload(value: unknown): InputPayload {
  const out: InputPayload = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = v;
  }
  return out;
}

/**
 * "The admin's next text message is the answer to X" — stored in `admin_states`
 * so it survives restarts and works with several processes.
 */
export class AdminStateStore {
  constructor(
    private readonly db: Db,
    private readonly ttlMs = INPUT_TTL_MS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async set(telegramUserId: bigint, state: string, payload: InputPayload = {}): Promise<void> {
    const expiresAt = new Date(this.now().getTime() + this.ttlMs);
    await this.db.adminState.upsert({
      where: { telegramUserId },
      create: { telegramUserId, state, payload, expiresAt },
      update: { state, payload, expiresAt },
    });
  }

  async get(telegramUserId: bigint): Promise<PendingInput | null> {
    const row = await this.db.adminState.findUnique({ where: { telegramUserId } });
    if (!row) return null;
    if (row.expiresAt.getTime() <= this.now().getTime()) {
      await this.clear(telegramUserId);
      return null;
    }
    return { state: row.state, payload: toPayload(row.payload), expiresAt: row.expiresAt };
  }

  /** Returns true when something was pending. */
  async clear(telegramUserId: bigint): Promise<boolean> {
    const result = await this.db.adminState.deleteMany({ where: { telegramUserId } });
    return result.count > 0;
  }
}
