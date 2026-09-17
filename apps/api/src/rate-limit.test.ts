import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit.ts";

describe("RateLimiter", () => {
  it("allows 20 hits per hour then rejects further attempts", () => {
    const limiter = new RateLimiter(20, 60 * 60 * 1000);
    const start = 1_700_000_000_000;
    for (let i = 0; i < 20; i += 1) {
      expect(limiter.allow("otp:127.0.0.1", start + i).ok).toBe(true);
    }
    const blocked = limiter.allow("otp:127.0.0.1", start + 20);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.retryAfterSec).toBeGreaterThan(0);
    }
    expect(limiter.allow("otp:10.0.0.2", start + 20).ok).toBe(true);
  });
});
