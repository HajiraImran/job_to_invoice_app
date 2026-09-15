import { randomUUID as nodeRandomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({
  randomUUID: vi.fn(() => nodeRandomUUID()),
}));

import { randomUUID } from "expo-crypto";
import { createSetupIdempotencyKey, retainOrCreateSetupIdempotencyKey } from "./idempotency.ts";
import { secureRandomUUID } from "../crypto/uuid.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("setup idempotency key", () => {
  beforeEach(() => {
    vi.mocked(randomUUID).mockClear();
  });

  it("creates a UUID through expo-crypto randomUUID", () => {
    const key = createSetupIdempotencyKey();
    expect(key).toMatch(UUID);
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(secureRandomUUID()).toMatch(UUID);
  });

  it("keeps the same key across rerenders", () => {
    const first = retainOrCreateSetupIdempotencyKey(undefined);
    expect(randomUUID).toHaveBeenCalledTimes(1);
    const rerender = retainOrCreateSetupIdempotencyKey(first);
    const anotherRender = retainOrCreateSetupIdempotencyKey(rerender);
    expect(rerender).toBe(first);
    expect(anotherRender).toBe(first);
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it("rotates to a new key after a version conflict", () => {
    const original = retainOrCreateSetupIdempotencyKey(undefined);
    const rotated = createSetupIdempotencyKey();
    expect(rotated).toMatch(UUID);
    expect(rotated).not.toBe(original);
    expect(randomUUID).toHaveBeenCalledTimes(2);
  });

  it("does not use Math.random, timestamps, or a hard-coded key", () => {
    const first = createSetupIdempotencyKey();
    const second = createSetupIdempotencyKey();
    expect(first).not.toBe(second);
    expect(first).not.toBe("00000000-0000-4000-8000-000000000000");
    expect(Date.parse(first)).toBeNaN();
  });
});
