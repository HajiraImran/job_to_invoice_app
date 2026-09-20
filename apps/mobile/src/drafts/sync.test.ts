import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT_SYNC } from "@job-to-invoice/schemas";
import {
  bindDraftSyncController,
  discardLocalDrafts,
  getDraftSyncStatus,
  LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED,
} from "./sync.ts";

describe("production draft-sync adapter", () => {
  it("is implemented and reports empty status until a sync controller is bound", async () => {
    bindDraftSyncController(null);
    expect(LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED).toBe(true);
    await expect(getDraftSyncStatus()).resolves.toEqual(EMPTY_DRAFT_SYNC);
    expect(EMPTY_DRAFT_SYNC).toEqual({ hasUnsyncedDrafts: false, synchronizeAvailable: false });
    await expect(discardLocalDrafts()).resolves.toBeUndefined();
  });
});
