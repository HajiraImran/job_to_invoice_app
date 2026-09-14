import { describe, expect, it } from "vitest";
import { SNAPSHOT_SCHEMA_VERSION } from "./index.ts";

describe("schemas foundation", () => {
  it("does not claim a product snapshot schema yet", () => {
    expect(SNAPSHOT_SCHEMA_VERSION).toBe(0);
  });
});
