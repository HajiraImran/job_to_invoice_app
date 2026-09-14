export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  allow(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSec: number } {
    const start = now - this.windowMs;
    const next = (this.hits.get(key) ?? []).filter((time) => time > start);
    if (next.length >= this.limit) {
      const retryAfterSec = Math.max(1, Math.ceil(((next[0] ?? now) + this.windowMs - now) / 1000));
      this.hits.set(key, next);
      return { ok: false, retryAfterSec };
    }
    next.push(now);
    this.hits.set(key, next);
    return { ok: true };
  }
}
