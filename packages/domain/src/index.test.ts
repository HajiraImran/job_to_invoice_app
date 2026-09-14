import { describe, expect, it } from "vitest";
import { usdCents } from "./index.ts";

describe("usdCents", () => {
  it("accepts integer cents", () => {
    expect(usdCents(25980)).toBe(25980);
  });

  it("rejects JavaScript floats", () => {
    expect(() => usdCents(19.99)).toThrow(/integer cents/);
  });
});
