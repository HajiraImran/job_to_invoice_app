import { describe, expect, it } from "vitest";
import { clearSetupDraft, loadSetupDraft, parseSetupDraft, saveSetupDraft, type SetupDraft } from "./draft.ts";
import { emptySetupForm, setupRequestFromForm } from "./form.ts";

function memoryStore(initial?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: async (key: string) => map.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: async (key: string) => {
      map.delete(key);
    },
    map,
  };
}

const draft = (workspaceId: string, extra?: Partial<SetupDraft>): SetupDraft => ({
  schema_version: 1,
  workspace_id: workspaceId,
  saved_at: "2026-09-14T12:00:00.000Z",
  step: 2,
  timezone_confirmed: false,
  tax_zero_confirmed: false,
  skip_logo: true,
  values: { ...emptySetupForm("owner@example.com", "America/New_York"), business_name: "Draft Biz" },
  ...extra,
});

describe("setup draft persistence", () => {
  it("restores a versioned draft for the same incomplete workspace", async () => {
    const store = memoryStore();
    await saveSetupDraft(store, draft("ws-1"));
    const loaded = await loadSetupDraft(store, "ws-1", false);
    expect(loaded?.values.business_name).toBe("Draft Biz");
    expect(loaded?.step).toBe(2);
  });

  it("does not restore a draft after setup is completed or for another workspace", async () => {
    expect(parseSetupDraft(JSON.stringify(draft("ws-1")), "ws-1", true)).toBeUndefined();
    expect(parseSetupDraft(JSON.stringify(draft("ws-1")), "ws-2", false)).toBeUndefined();
    expect(parseSetupDraft("{", "ws-1", false)).toBeUndefined();
  });

  it("clears the draft only through the explicit success path", async () => {
    const store = memoryStore();
    await saveSetupDraft(store, draft("ws-1"));
    await clearSetupDraft(store);
    expect(await loadSetupDraft(store, "ws-1", false)).toBeUndefined();
  });
});

describe("setup request mapping", () => {
  it("keeps a valid form for submit and retains values after a failed parse", () => {
    const values = emptySetupForm("Owner.Plus+tag@Example.COM", "America/Chicago");
    values.business_name = "José's Handyman";
    values.legal_name = "José's Handyman LLC";
    values.contact_name = "José García";
    values.trade = "handyman";
    values.line1 = "123 Main";
    values.city = "Austin";
    values.state = "TX";
    values.postal_code = "78701-1234";
    values.tax_percent = "8.25";
    values.due_preset = "14";
    const parsed = setupRequestFromForm(values, {
      timezoneConfirmed: true,
      taxZeroConfirmed: false,
      skipLogo: true,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.default_tax_bp).toBe(825);
      expect(parsed.value.contact_email).toBe("Owner.Plus+tag@Example.COM");
    }
    const invalid = setupRequestFromForm(values, {
      timezoneConfirmed: false,
      taxZeroConfirmed: false,
      skipLogo: true,
    });
    expect(invalid.ok).toBe(false);
    expect(values.business_name).toBe("José's Handyman");
  });
});
