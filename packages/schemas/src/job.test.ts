import { describe, expect, it } from "vitest";
import {
  parseJobCreate,
  parseJobListQuery,
  analyticsModeForJob,
  JOB_LIST_DEFAULT_LIMIT,
} from "./job.ts";

function validJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    customer_name: "José García",
    title: "Kitchen faucet",
    no_site: false,
    site_address: {
      line1: "123 Main Street",
      city: "Austin",
      state: "TX",
      postal_code: "78701",
    },
    internal_notes: "Rear door.",
    mode: "quote",
    ...overrides,
  };
}

describe("VAL01 job and customer names", () => {
  it("trims Unicode names and titles within bounds", () => {
    const parsed = parseJobCreate(validJob({ customer_name: "  José  ", title: "  Faucet  " }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.customer_name).toBe("José");
      expect(parsed.value.title).toBe("Faucet");
    }
  });

  it("rejects empty, overlong, and control characters", () => {
    expect(parseJobCreate(validJob({ customer_name: "" })).ok).toBe(false);
    expect(parseJobCreate(validJob({ title: "A".repeat(121) })).ok).toBe(false);
    expect(parseJobCreate(validJob({ customer_name: "A\u0007B" })).ok).toBe(false);
    expect(parseJobCreate(validJob({ title: "" })).ok).toBe(false);
  });
});

describe("job create contract", () => {
  it("requires a client UUID, mode, and exclusive site choice", () => {
    expect(parseJobCreate(validJob({ id: "not-a-uuid" })).ok).toBe(false);
    expect(parseJobCreate(validJob({ mode: "invoice" })).ok).toBe(false);
    expect(parseJobCreate(validJob({ no_site: true, site_address: validJob().site_address })).ok).toBe(false);
    const remote = parseJobCreate(validJob({ no_site: true, site_address: null }));
    expect(remote.ok).toBe(true);
    if (remote.ok) {
      expect(remote.value.site_address).toBeNull();
      expect(remote.value.mode).toBe("quote");
    }
  });

  it("rejects tenant ownership and publication fields", () => {
    const forged = parseJobCreate(validJob({ workspace_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
    expect(forged.ok).toBe(false);
    if (!forged.ok) {
      expect(forged.field_errors.some((item) => item.field === "workspace_id")).toBe(true);
    }
    expect(parseJobCreate(validJob({ lifecycle: "active" })).ok).toBe(false);
    expect(parseJobCreate(validJob({ completion_right: true })).ok).toBe(false);
  });

  it("maps direct invoice mode for analytics without customer text", () => {
    expect(analyticsModeForJob("direct_invoice")).toBe("direct");
    expect(analyticsModeForJob("quote")).toBe("quote");
  });

  it("allows empty internal notes and preserves newlines", () => {
    const empty = parseJobCreate(validJob({ internal_notes: "   " }));
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.value.internal_notes).toBe("");
    }
    const notes = parseJobCreate(validJob({ internal_notes: "Line 1\nLine 2" }));
    expect(notes.ok).toBe(true);
    expect(parseJobCreate(validJob({ internal_notes: "x".repeat(4001) })).ok).toBe(false);
  });
});

describe("job list query", () => {
  it("defaults to open jobs with a pagination-ready page size", () => {
    const parsed = parseJobListQuery({});
    expect(parsed).toEqual({
      ok: true,
      value: { cursor: null, limit: JOB_LIST_DEFAULT_LIMIT, search: null, state: "open" },
    });
  });

  it("rejects unknown filters and oversized limits", () => {
    expect(parseJobListQuery({ workspace_id: "x" }).ok).toBe(false);
    expect(parseJobListQuery({ limit: 101 }).ok).toBe(false);
    expect(parseJobListQuery({ state: "draft" }).ok).toBe(false);
    const ok = parseJobListQuery({ cursor: "abc", limit: "10", search: "faucet", state: "archived" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.limit).toBe(10);
      expect(ok.value.state).toBe("archived");
      expect(ok.value.search).toBe("faucet");
    }
  });
});
