import { describe, expect, it } from "vitest";
import { deletionStatusLabel, presentDeletion } from "./presentation.ts";

describe("S24 deletion presentation", () => {
  it("blocks offline, expired, and already locked accounts", () => {
    expect(presentDeletion({ authStatus: "offline_cached", requesting: false, stepUp: false, confirmation: "DELETE" })).toEqual({
      kind: "offline",
      confirmDisabled: true,
    });
    expect(
      presentDeletion({ authStatus: "access_expired", requesting: false, stepUp: false, confirmation: "DELETE" }).kind,
    ).toBe("access_expired");
    expect(
      presentDeletion({
        authStatus: "authenticated",
        accountStatus: "deleting",
        requesting: false,
        stepUp: false,
        confirmation: "DELETE",
      }).kind,
    ).toBe("locked");
    expect(deletionStatusLabel("locked")).toContain("locked");
  });

  it("requires the exact DELETE phrase before confirm", () => {
    expect(
      presentDeletion({
        authStatus: "authenticated",
        requesting: false,
        stepUp: false,
        confirmation: "delete",
      }),
    ).toEqual({ kind: "ready", confirmDisabled: true });
    expect(
      presentDeletion({
        authStatus: "authenticated",
        requesting: false,
        stepUp: false,
        confirmation: "DELETE",
      }),
    ).toEqual({ kind: "ready", confirmDisabled: false });
  });
});
