import { analyticsPropertiesAreSafe } from "@job-to-invoice/schemas";
import { describe, expect, it } from "vitest";
import {
  CUSTOMER_LIST_LIMIT,
  CUSTOMER_SEARCH_DEBOUNCE_MS,
  appendCustomerPage,
  customerActionSheet,
  customerAnalyticsProperties,
  customerArchiveBody,
  customerDetailVisible,
  customerEmptyBody,
  customerHardwareBack,
  customerIdempotencyAfterFailure,
  customerJobCountLabel,
  customerJobSummary,
  customerJobsPath,
  customerListContact,
  customerListPath,
  customerListRow,
  customerMutationAllowed,
  customerResponseCurrent,
  customerResultLabel,
  customerRowsAfterLoad,
  maskCustomerPhone,
  presentCustomerList,
  type CustomerRecord,
} from "./presentation.ts";

const customer = (id: string, name: string, extra: Partial<CustomerRecord> = {}): CustomerRecord => ({
  id,
  name,
  email: "alex.rivera@example.com",
  phone: "+14155550184",
  billing_address: null,
  archived_at: null,
  version: 1,
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  ...extra,
});

describe("S19 customer list", () => {
  it("keeps server search, filters, limit and cursor on the list request", () => {
    expect(CUSTOMER_SEARCH_DEBOUNCE_MS).toBe(300);
    expect(CUSTOMER_LIST_LIMIT).toBe(25);
    expect(customerListPath({ state: "active", search: "" })).toBe("/v1/customers?state=active&limit=25");
    expect(customerListPath({ state: "archived", search: "Ada", cursor: "cursor-1" })).toBe(
      "/v1/customers?state=archived&limit=25&search=Ada&cursor=cursor-1",
    );
    expect(customerListPath({ state: "all", search: "Ada", limit: 100 })).toContain("state=all");
    expect(customerListPath({ state: "active", search: "Ada" })).not.toMatch(/normalized_email|workspace_id/);
  });

  it("rejects a stale search response and resets pages when the query changes", () => {
    expect(customerResponseCurrent(2, 2)).toBe(true);
    expect(customerResponseCurrent(1, 2)).toBe(false);
    const previous = [customer("11111111-1111-4111-8111-111111111111", "Ada")];
    const next = [customer("22222222-2222-4222-8222-222222222222", "Bea")];
    expect(customerRowsAfterLoad({ previous, next, failed: false, sameQuery: false, append: false })).toEqual(next);
    expect(customerRowsAfterLoad({ previous, failed: true, sameQuery: true, append: false })).toEqual(previous);
    expect(customerRowsAfterLoad({ previous, failed: true, sameQuery: false, append: false })).toEqual([]);
  });

  it("appends a cursor page without duplicating customers", () => {
    const first = customer("11111111-1111-4111-8111-111111111111", "Ada");
    const second = customer("22222222-2222-4222-8222-222222222222", "Bea");
    expect(appendCustomerPage([first], [first, second])).toEqual([first, second]);
    expect(
      customerRowsAfterLoad({ previous: [first], next: [second], failed: false, sameQuery: true, append: true }),
    ).toEqual([first, second]);
  });

  it("keeps loaded rows on a refresh failure and uses empty copy by filter", () => {
    const rows = [customer("11111111-1111-4111-8111-111111111111", "Ada")];
    const refreshed = presentCustomerList({
      authStatus: "authenticated",
      loading: false,
      loadedOnce: true,
      customers: rows,
      queryMatches: true,
      error: { message: "Could not load customers. Try again.", retryable: true },
    });
    expect(refreshed.kind).toBe("loaded");
    expect(refreshed.customers).toEqual(rows);
    expect(refreshed.showRetry).toBe(true);
    expect(presentCustomerList({ authStatus: "authenticated", loading: true, loadedOnce: false, customers: [] }).kind).toBe(
      "loading",
    );
    expect(
      presentCustomerList({ authStatus: "authenticated", loading: false, loadedOnce: true, customers: [] }).kind,
    ).toBe("empty");
    expect(customerEmptyBody("active")).toMatch(/active customers/i);
    expect(customerEmptyBody("archived")).toMatch(/restored/i);
    expect(customerEmptyBody("all")).toMatch(/Created customers/i);
    expect(customerResultLabel("active", 2, true)).toBe("2 active customers");
    expect(customerResultLabel("active", 2, false)).toBeUndefined();
  });

  it("hides records and add when offline or access has expired", () => {
    const rows = [customer("11111111-1111-4111-8111-111111111111", "Ada")];
    const offline = presentCustomerList({
      authStatus: "offline_cached",
      loading: false,
      loadedOnce: true,
      customers: rows,
    });
    expect(offline).toMatchObject({ kind: "offline", customers: [], showAdd: false, showRetry: true });
    const expired = presentCustomerList({
      authStatus: "access_expired",
      loading: false,
      loadedOnce: true,
      customers: rows,
    });
    expect(expired).toMatchObject({ kind: "access_expired", customers: [], showAdd: false });
    expect(customerDetailVisible("access_expired", rows[0])).toBeUndefined();
    expect(customerDetailVisible("offline_cached", rows[0])).toBeUndefined();
    expect(customerMutationAllowed(false, "offline_cached")).toBe(false);
    expect(customerMutationAllowed(true, "authenticated")).toBe(false);
    expect(customerMutationAllowed(false, "authenticated")).toBe(true);
  });

  it("masks list contact details and omits private fields and unsupported job counts", () => {
    const row = customerListRow(customer("11111111-1111-4111-8111-111111111111", "Alex Rivera"));
    expect(row.contact).toBe("a***@example.com");
    expect(row.contact).not.toContain("alex.rivera@example.com");
    expect(row.jobCountLabel).toBeUndefined();
    expect(row.initials).toBe("AR");
    expect(JSON.stringify(row)).not.toMatch(/normalized_email|workspace_id|alex\.rivera@example\.com/);
    expect(customerListContact({ email: null, phone: "+14155559821" })).toBe(maskCustomerPhone("+14155559821"));
    expect(customerJobCountLabel(undefined)).toBeUndefined();
    expect(customerJobCountLabel(0)).toBe("No jobs");
    expect(customerAnalyticsProperties()).toEqual({});
    expect(analyticsPropertiesAreSafe(customerAnalyticsProperties())).toBe(true);
  });
});

describe("S19 customer detail", () => {
  it("shows lifecycle text and no invented amount", () => {
    const summary = customerJobSummary({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Northside Porch Repair",
      lifecycle: "draft",
    });
    expect(summary).toEqual({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Northside Porch Repair",
      status: "Draft",
    });
    expect(summary).not.toHaveProperty("amount");
    expect(customerJobsPath("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toBe(
      "/v1/jobs?customer_id=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb&limit=25",
    );
  });

  it("offers archive, restore, and delete only from the loaded job state", () => {
    expect(customerActionSheet({ archived: false, jobsLoaded: true, referenced: true })).toEqual({
      actions: ["edit", "archive"],
      deleteUnavailable: true,
    });
    expect(customerActionSheet({ archived: true, jobsLoaded: true, referenced: true })).toEqual({
      actions: ["edit", "restore"],
      deleteUnavailable: true,
    });
    expect(customerActionSheet({ archived: false, jobsLoaded: true, referenced: false }).actions).toContain("delete");
    expect(customerActionSheet({ archived: true, jobsLoaded: false, referenced: false }).actions).not.toContain("delete");
    expect(customerArchiveBody(true)).toEqual({ archived: true });
    expect(customerArchiveBody(false)).toEqual({ archived: false });
    expect(customerArchiveBody(true)).not.toHaveProperty("version");
  });

  it("closes the action sheet on Android back and reuses the idempotency key after an ambiguous failure", () => {
    expect(customerHardwareBack(true)).toBe("close_sheet");
    expect(customerHardwareBack(false)).toBe("leave");
    expect(customerIdempotencyAfterFailure("key-1", "UNAVAILABLE")).toBe("key-1");
    expect(customerIdempotencyAfterFailure("key-1", "RATE_LIMITED")).toBe("key-1");
    expect(customerIdempotencyAfterFailure("key-1", "CUSTOMER_REFERENCED")).toBeUndefined();
    expect(customerIdempotencyAfterFailure("key-1", "NOT_FOUND")).toBeUndefined();
  });
});
