/**
 * Fixed-window rate limiter, in-isolate memory.
 *
 * Honest limits: a Workers isolate is not a global counter. Under load,
 * traffic spreads across isolates and the effective limit is higher than
 * configured. That is acceptable here — the limiter's job is to blunt a
 * runaway client or a leaked read token, not to bill anyone. For a hard
 * global limit, back this with KV / a Durable Object (v1.1 candidate).
 */
export class RateLimiter {
  private buckets = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly limitPerMinute: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Returns true when the request is allowed. */
  check(key: string): boolean {
    if (this.limitPerMinute <= 0) return true;
    const now = this.now();
    const windowStart = Math.floor(now / 60_000) * 60_000;
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.windowStart !== windowStart) {
      this.buckets.set(key, { windowStart, count: 1 });
      this.prune(windowStart);
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.limitPerMinute;
  }

  private prune(currentWindow: number): void {
    if (this.buckets.size < 1000) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.windowStart < currentWindow) this.buckets.delete(key);
    }
  }
}

export function parseRateLimit(raw: string | undefined, fallback = 60): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
