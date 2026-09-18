import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT_SYNC } from "@job-to-invoice/schemas";
import { discardLocalDrafts, getDraftSyncStatus, LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED } from "./sync.ts";

describe("production draft-sync adapter", () => {
  it("stays explicitly empty until SYNC01 local persistence exists", async () => {
    expect(LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED).toBe(false);
    await expect(getDraftSyncStatus()).resolves.toEqual(EMPTY_DRAFT_SYNC);
    expect(EMPTY_DRAFT_SYNC).toEqual({ hasUnsyncedDrafts: false, synchronizeAvailable: false });
    await expect(discardLocalDrafts()).resolves.toBeUndefined();
  });
});
