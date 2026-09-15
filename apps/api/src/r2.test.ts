import { describe, expect, it } from "vitest";
import { PRESIGN_EXPIRES_SECONDS } from "./r2.ts";

describe("R2 download store", () => {
  it("mints five-minute GET URLs", () => {
    expect(PRESIGN_EXPIRES_SECONDS).toBe(300);
  });
});
