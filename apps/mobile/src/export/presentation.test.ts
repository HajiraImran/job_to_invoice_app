import { describe, expect, it } from "vitest";
import { exportPath, exportStatusLabel, presentExport } from "./presentation.ts";

describe("S24 export presentation", () => {
  it("blocks offline and expired sessions and exposes the settings route", () => {
    expect(exportPath()).toBe("/(tabs)/settings/data");
    expect(presentExport({ authStatus: "offline_cached", loading: false, requesting: false, stepUp: false })).toEqual({
      kind: "offline",
      exportDisabled: true,
    });
    expect(presentExport({ authStatus: "access_expired", loading: false, requesting: false, stepUp: false }).kind).toBe(
      "access_expired",
    );
    expect(exportStatusLabel("ready")).toBe("Export ready");
  });

  it("shows step-up and working states before download", () => {
    expect(
      presentExport({ authStatus: "authenticated", loading: false, requesting: false, stepUp: true }).kind,
    ).toBe("step_up");
    expect(
      presentExport({
        authStatus: "authenticated",
        loading: false,
        requesting: false,
        stepUp: false,
        record: {
          id: "e1",
          status: "queued",
          cutoff_at: null,
          created_at: null,
          download_until: null,
          delete_after: null,
          ready_at: null,
          schema_version: 1,
          part_count: 1,
          job_count: null,
          bytes: null,
          sha256: null,
          download_available: false,
          manifest: null,
          error_code: null,
        },
      }).kind,
    ).toBe("working");
  });
});
