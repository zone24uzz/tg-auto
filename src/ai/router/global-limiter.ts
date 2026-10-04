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

  private evict(t: number): void {
    while (this.head < this.stamps.length && (this.stamps[this.head] ?? 0) <= t - WINDOW_MS) this.head++;
    // Compact occasionally so the array does not grow without bound.
    if (this.head > 1024 && this.head * 2 > this.stamps.length) {
      this.stamps = this.stamps.slice(this.head);
      this.head = 0;
    }
  }
}
