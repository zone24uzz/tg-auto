/**
 * In-memory sliding-window limiter for the total number of AI calls per minute (process-wide).
 * Every provider attempt (including fallbacks) consumes one slot.
 */
const WINDOW_MS = 60_000;

export class GlobalLimiter {
  private stamps: number[] = [];
  private head = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Takes a slot when fewer than `limitPerMinute` calls happened in the last 60s. */
  tryAcquire(limitPerMinute: number): boolean {
    const t = this.now();
    this.evict(t);
    if (this.stamps.length - this.head >= Math.max(0, Math.floor(limitPerMinute))) return false;
    this.stamps.push(t);
    return true;
  }

  /** Calls counted in the current window. */
  inWindow(): number {
    this.evict(this.now());
    return this.stamps.length - this.head;
  }

  protected evict(t: number): void {
    while (this.head < this.stamps.length && (this.stamps[this.head] ?? 0) <= t - WINDOW_MS) this.head++;
    // Compact occasionally so the array does not grow without bound.
    if (this.head > 1024 && this.head * 2 > this.stamps.length) {
      this.stamps = this.stamps.slice(this.head);
      this.head = 0;
    }
  }
}

/** Per-workspace windows: each tenant's `globalAiRequestsPerMinute` applies to its own calls only. */
export class TenantLimiter extends GlobalLimiter {
  private readonly windows = new Map<number, GlobalLimiter>();

  constructor(
    private readonly tenantKey: () => number,
    private readonly clock: () => number = Date.now,
  ) {
    super(clock);
  }

  private window(): GlobalLimiter {
    const key = this.tenantKey();
    let w = this.windows.get(key);
    if (!w) this.windows.set(key, (w = new GlobalLimiter(this.clock)));
    return w;
  }

  override tryAcquire(limitPerMinute: number): boolean {
    return this.window().tryAcquire(limitPerMinute);
  }

  override inWindow(): number {
    return this.window().inWindow();
  }
}
