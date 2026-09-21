import { describe, expect, it } from "vitest";
import { jobFormFocusName, jobRequestFromForm, emptyJobForm, listStateFromFilter } from "./form.ts";
import { presentJobDetail, presentJobsList, nextActionCopy } from "./presentation.ts";
import { canOpenCreateJob, createJobDisabled, createJobPath, jobDetailPath, jobPublishPath, jobQuotePath, jobsIndexPath } from "./routes.ts";

describe("job form", () => {
  it("maps a complete form to a create payload", () => {
    const parsed = jobRequestFromForm(
      {
        ...emptyJobForm(),
        customer_name: "Riley Chen",
        title: "Kitchen faucet",
        line1: "123 Main Street",
        city: "Austin",
        state: "TX",
        postal_code: "78701",
        mode: "quote",
      },
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(parsed.ok).toBe(true);
  });

  it("requires title, customer, mode, and explicit no-site", () => {
    const missing = jobRequestFromForm(emptyJobForm(), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(missing.ok).toBe(false);
    const remote = jobRequestFromForm(
      { ...emptyJobForm(), customer_name: "Riley", title: "Remote", no_site: true, mode: "direct_invoice" },
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(remote.ok).toBe(true);
    if (remote.ok) {
      expect(remote.value.site_address).toBeNull();
      expect(remote.value.mode).toBe("direct_invoice");
    }
  });

  it("focuses the first invalid site field", () => {
    expect(jobFormFocusName("site_address.line1")).toBe("line1");
    expect(jobFormFocusName("site_address")).toBe("line1");
    expect(listStateFromFilter("active")).toBe("open");
    expect(listStateFromFilter("archived")).toBe("archived");
  });
});

describe("jobs list and detail states", () => {
  const job = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    customer_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    customer_name: "Riley",
    title: "Faucet",
    lifecycle: "draft",
    mode: "quote",
    no_site: true,
    version: 1,
    created_at: "2026-09-15T00:00:00.000Z",
    updated_at: "2026-09-15T00:00:00.000Z",
  };

  it("shows loading, empty, error, and success without shifting create", () => {
    expect(
      presentJobsList({ authStatus: "authenticated", loading: true, loadedOnce: false, items: [], searching: false }).kind,
    ).toBe("loading");
    expect(
      presentJobsList({
        authStatus: "authenticated",
        loading: false,
        loadedOnce: true,
        items: [],
        searching: false,
      }).kind,
    ).toBe("empty");
    const error = presentJobsList({
      authStatus: "authenticated",
      loading: false,
      loadedOnce: false,
      items: [],
      searching: false,
      error: { message: "Could not load jobs. Try again.", retryable: true },
    });
    expect(error.kind).toBe("error");
    expect(error.showRetry).toBe(true);
    expect(error.showCreate).toBe(true);
    const loaded = presentJobsList({
      authStatus: "authenticated",
      loading: false,
      loadedOnce: true,
      items: [job],
      searching: false,
    });
    expect(loaded.kind).toBe("loaded");
    expect(loaded.items).toHaveLength(1);
  });

  it("keeps cached jobs offline and blocks create until reconnected", () => {
    const offline = presentJobsList({
      authStatus: "offline_cached",
      loading: false,
      loadedOnce: true,
      items: [job],
      searching: true,
    });
    expect(offline.showOfflineBanner).toBe(true);
    expect(offline.showCreate).toBe(true);
    expect(offline.showSearchDownloaded).toBe(true);
    expect(createJobDisabled("offline_cached", false)).toBe(false);
    expect(createJobDisabled("authenticated", false)).toBe(false);
    expect(createJobDisabled("access_expired", false)).toBe(true);
    expect(canOpenCreateJob("authenticated")).toBe(true);
  });

  it("presents detail loading, missing, and draft next-action copy", () => {
    expect(presentJobDetail({ authStatus: "authenticated", loading: true }).kind).toBe("loading");
    expect(
      presentJobDetail({
        authStatus: "authenticated",
        loading: false,
        error: { message: "missing", retryable: false, status: 404 },
      }).kind,
    ).toBe("missing");
    expect(nextActionCopy("quote", "draft")).toBe("quote");
    expect(nextActionCopy("direct_invoice", "draft")).toBe("direct");
    expect(nextActionCopy("quote", "active")).toBe("published");
    expect(nextActionCopy("quote", "active", "declined")).toBe("quote");
    expect(nextActionCopy("quote", "active", "accepted")).toBe("invoice");
    expect(nextActionCopy("quote", "invoiced", "accepted", true)).toBe("view_invoice");
    expect(nextActionCopy("quote", "invoiced", "accepted", false)).toBe("replace_invoice");
    expect(nextActionCopy("quote", "active", "expired")).toBe("quote");
    expect(nextActionCopy("quote", "active", "superseded")).toBe("quote");
  });
});

describe("job navigation", () => {
  it("keeps create and detail under the Jobs tab", () => {
    expect(jobsIndexPath()).toBe("/(tabs)/jobs");
    expect(createJobPath()).toBe("/(tabs)/jobs/new");
    expect(jobDetailPath("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(
      "/(tabs)/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(jobQuotePath("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(
      "/(tabs)/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/quote",
    );
    expect(jobPublishPath("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(
      "/(tabs)/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/publish",
    );
  });
});
