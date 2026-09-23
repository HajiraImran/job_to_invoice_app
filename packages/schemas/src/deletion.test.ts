import { describe, expect, it } from "vitest";
import { DELETION_CONFIRMATION, parseDeletionRequest } from "./deletion.ts";

describe("account deletion confirmation", () => {
  it("accepts only the exact DELETE phrase (PRV03)", () => {
    expect(DELETION_CONFIRMATION).toBe("DELETE");
    expect(parseDeletionRequest({ confirmation: "DELETE" })).toEqual({
      ok: true,
      value: { confirmation: "DELETE" },
    });
    expect(parseDeletionRequest({ confirmation: "delete" }).ok).toBe(false);
    expect(parseDeletionRequest({ confirmation: "DELETE ", extra: true }).ok).toBe(false);
    expect(parseDeletionRequest({ confirmation: "REMOVE" }).ok).toBe(false);
    expect(parseDeletionRequest({})).toEqual({
      ok: false,
      field_errors: [{ field: "confirmation", message: "Type DELETE to confirm deletion." }],
    });
  });
});
