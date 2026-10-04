import { randomUUID } from 'node:crypto';
import type { Db } from '../database/client.js';
import { childLogger } from '../logging/logger.js';
import { describeError } from '../logging/sanitize.js';

const log = childLogger('chat-lease');

export const LEASE_MS = 2 * 60_000;
export const LEASE_HEARTBEAT_MS = 30_000;

/**
 * Per-chat processing lease with an owner token.
 * Only the holder (same token) may renew or release it, so a worker whose lease expired can never
 * clear the lease of the worker that took over. While held, a timer renews it every
 * LEASE_HEARTBEAT_MS so long AI calls, media processing and reply delays don't let it expire.
 */
export class ChatLease {
  private timer: NodeJS.Timeout | null = null;
  private lost = false;
  private released = false;

  private constructor(
    private readonly db: Db,
    readonly chatId: number,
    readonly token: string,
    private readonly leaseMs: number,
  ) {}

  /** Takes the lease when it is free or expired; null when another live holder has it. */
  static async acquire(
    db: Db,
    chatId: number,
    opts: { leaseMs?: number; heartbeatMs?: number } = {},
  ): Promise<ChatLease | null> {
    const leaseMs = opts.leaseMs ?? LEASE_MS;
    const token = randomUUID();
    const now = new Date();
    const result = await db.chat.updateMany({
      where: { id: chatId, OR: [{ processingUntil: null }, { processingUntil: { lt: now } }] },
      data: { processingUntil: new Date(now.getTime() + leaseMs), processingToken: token },
    });
    if (result.count !== 1) return null;
    const lease = new ChatLease(db, chatId, token, leaseMs);
    const heartbeatMs = opts.heartbeatMs ?? LEASE_HEARTBEAT_MS;
    lease.timer = setInterval(() => void lease.renew(), heartbeatMs);
    lease.timer.unref();
    return lease;
  }

  /** Extends the lease; false (and marked lost) when somebody else holds it now. */
  async renew(): Promise<boolean> {
    if (this.released || this.lost) return false;
    try {
      const result = await this.db.chat.updateMany({
        where: { id: this.chatId, processingToken: this.token },
        data: { processingUntil: new Date(Date.now() + this.leaseMs) },
      });
      if (result.count !== 1) {
        this.lost = true;
        log.warn({ chatId: this.chatId }, 'chat lease lost (taken over by another worker)');
      }
    } catch (error) {
      log.warn({ chatId: this.chatId, error: describeError(error) }, 'chat lease renewal failed');
    }
    return !this.lost;
  }

  /** Re-reads the lease: still ours and not expired. */
  async stillHeld(): Promise<boolean> {
    if (this.released || this.lost) return false;
    const chat = await this.db.chat.findUnique({
      where: { id: this.chatId },
      select: { processingToken: true, processingUntil: true },
    });
    const held = chat?.processingToken === this.token && !!chat.processingUntil && chat.processingUntil.getTime() > Date.now();
    if (!held) this.lost = true;
    return held;
  }

  /** Releases the lease only when it is still ours (never clears another holder's lease). */
  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.released) return;
    this.released = true;
    await this.db.chat
      .updateMany({ where: { id: this.chatId, processingToken: this.token }, data: { processingUntil: null, processingToken: null } })
      .catch((error: unknown) => log.warn({ chatId: this.chatId, error: describeError(error) }, 'chat lease release failed'));
  }
}
