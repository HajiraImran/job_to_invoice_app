import { describe, expect, it } from "vitest";
import { copy } from "../i18n/en.ts";
import { presentQuoteEditor } from "./presentation.ts";
import { conflictActionBlocked, conflictHardwareBack, presentConflictRecovery } from "./conflict-presentation.ts";

const SENTENCE = "This draft changed on another device. Review both versions before continuing.";

describe("S23 conflict presentation", () => {
  it("uses the required NTF05 sentence and hides commercial content", () => {
    const view = presentConflictRecovery({
      authStatus: "authenticated",
      saveStatus: "conflict",
      hasDraft: true,
      storageAvailable: true,
    });
    expect(view.surface).toBe("conflict");
    expect(view.sentence).toBe(SENTENCE);
    expect(copy.conflictBody).toBe(SENTENCE);
    expect(view.showCommercialContent).toBe(false);
    expect(view.keepServerEnabled).toBe(true);
    expect(view.saveLocalEnabled).toBe(true);
  });

  it("lets conflict override a ready editor", () => {
    expect(
      presentQuoteEditor({
        authStatus: "authenticated",
        loading: false,
        draft: { id: "draft-1" },
        saveStatus: "conflict",
      }).kind,
    ).toBe("conflict");
  });

  it("lets access expiry override and hide conflict data", () => {
    expect(
      presentQuoteEditor({
        authStatus: "access_expired",
        loading: false,
        draft: { id: "draft-1" },
        saveStatus: "conflict",
        error: { message: "hidden", retryable: false, status: 401, code: "VERSION_CONFLICT" },
      }).kind,
    ).toBe("access_expired");
    expect(
      presentConflictRecovery({
        authStatus: "access_expired",
        saveStatus: "conflict",
        hasDraft: true,
        storageAvailable: true,
      }),
    ).toEqual({
      surface: "access_expired",
      sentence: copy.accessExpired,
      keepServerEnabled: false,
      saveLocalEnabled: false,
      showCommercialContent: false,
    });
    expect(copy.accessExpired).toBe("Sign in again to refresh your account.");
  });

  it("disables keep-server while offline and still allows a local copy", () => {
    expect(
      presentConflictRecovery({
        authStatus: "offline_cached",
        saveStatus: "conflict",
        hasDraft: true,
        storageAvailable: true,
      }),
    ).toMatchObject({
      surface: "offline_conflict",
      keepServerEnabled: false,
      saveLocalEnabled: true,
      showCommercialContent: false,
    });
  });

  it("sends hardware back to the job without treating expiry as navigation", () => {
    expect(conflictHardwareBack("conflict")).toBe("job");
    expect(conflictHardwareBack("offline_conflict")).toBe("job");
    expect(conflictHardwareBack("access_expired")).toBe("stay");
  });

  it("blocks a second tap while a resolution is busy", () => {
    expect(conflictActionBlocked(false)).toBe(false);
    expect(conflictActionBlocked(true)).toBe(true);
  });
});
