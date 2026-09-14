import { describe, expect, it } from "vitest";
import {
  MONEY_ERROR_CODES,
  MONEY_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
} from "./index.ts";

describe("versioned money schemas", () => {
  it("publishes money schema v1 without claiming a commercial snapshot schema", () => {
    expect(MONEY_SCHEMA_VERSION).toBe(1);
    expect(SNAPSHOT_SCHEMA_VERSION).toBe(0);
    expect(MONEY_ERROR_CODES.CREDIT_EXCEEDS_SOURCE).toBe("CREDIT_EXCEEDS_SOURCE");
    expect(MONEY_ERROR_CODES.REFUND_EXCEEDS_BALANCE).toBe("REFUND_EXCEEDS_BALANCE");
    expect(MONEY_ERROR_CODES.ENTRY_ALREADY_REVERSED).toBe("ENTRY_ALREADY_REVERSED");
  });
});
