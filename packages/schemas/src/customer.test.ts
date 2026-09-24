import { describe, expect, it } from "vitest";
import { API_ERROR_CODES, httpStatusForCode } from "./envelope.ts";
import { parseJobCreate, parseJobListQuery } from "./job.ts";
import {
  parseCustomerArchive,
  parseCustomerCreate,
  parseCustomerListQuery,
  parseCustomerPatch,
} from "./customer.ts";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function address(overrides: Record<string, unknown> = {}) {
  return {
    line1: "123 Main Street",
    city: "Austin",
    state: "TX",
    postal_code: "78701",
    ...overrides,
  };
}

describe("customer schema", () => {
  it("accepts a Unicode name and optional contact fields", () => {
    const parsed = parseCustomerCreate({
      id: ID,
      name: "  José García  ",
      email: "Owner.Plus+tag@Gmail.COM",
      phone: "+12025550123",
      billing_address: address(),
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.name).toBe("José García");
      expect(parsed.value.email).toBe("Owner.Plus+tag@Gmail.COM");
      expect(parsed.value.normalized_email).toBe("owner.plus+tag@gmail.com");
      expect(parsed.value.phone).toBe("+12025550123");
      expect(parsed.value.billing_address?.postal_code).toBe("78701");
      expect(parsed.value.confirm_duplicate_email).toBe(false);
    }
  });

  it("does not rewrite Gmail dots or plus tags", () => {
    const dotted = parseCustomerCreate({ name: "Ada", email: "a.b+tag@gmail.com" });
    const compact = parseCustomerCreate({ name: "Ada", email: "ab@gmail.com" });
    expect(dotted.ok && compact.ok).toBe(true);
    if (dotted.ok && compact.ok) {
      expect(dotted.value.normalized_email).toBe("a.b+tag@gmail.com");
      expect(dotted.value.normalized_email).not.toBe(compact.value.normalized_email);
    }
  });

  it("rejects national numbers, zip, and incomplete addresses", () => {
    expect(parseCustomerCreate({ name: "Ada", phone: "2025550123" }).ok).toBe(false);
    const zip = parseCustomerCreate({
      name: "Ada",
      billing_address: { ...address(), zip: "78701" },
    });
    expect(zip.ok).toBe(false);
    expect(parseCustomerCreate({ name: "Ada", billing_address: address({ postal_code: "7870" }) }).ok).toBe(false);
    expect(parseCustomerCreate({ name: "Ada", email: "not-an-email" }).ok).toBe(false);
  });

  it("rejects workspace and normalized email from the client", () => {
    const parsed = parseCustomerCreate({ name: "Ada", workspace_id: ID, normalized_email: "ada@example.com" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.field_errors.map((item) => item.field)).toEqual(expect.arrayContaining(["workspace_id", "normalized_email"]));
    }
  });

  it("patches only supplied fields and requires If-Match separately from archive", () => {
    const patch = parseCustomerPatch({ phone: null });
    expect(patch.ok).toBe(true);
    if (patch.ok) {
      expect(patch.value.phone).toBeNull();
      expect(patch.value).not.toHaveProperty("name");
    }
    expect(parseCustomerPatch({}).ok).toBe(false);
    const archive = parseCustomerArchive({ archived: true });
    expect(archive.ok).toBe(true);
    expect(parseCustomerArchive({ archived: true, version: 1 }).ok).toBe(false);
  });

  it("binds list filters and defaults to active", () => {
    const parsed = parseCustomerListQuery({ state: "archived", search: "José", limit: "2" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toMatchObject({ state: "archived", search: "José", limit: 2, cursor: null });
    }
    expect(parseCustomerListQuery(null).ok).toBe(true);
    expect(parseCustomerListQuery({ state: "open" }).ok).toBe(false);
    expect(parseCustomerListQuery({ workspace_id: ID }).ok).toBe(false);
  });
});

describe("customer job selection", () => {
  it("accepts exactly one of customer_id or customer_name", () => {
    const saved = parseJobCreate({
      id: ID,
      customer_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      title: "Faucet",
      no_site: true,
      mode: "quote",
    });
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.value.customer_name).toBeNull();
    }
    expect(
      parseJobCreate({
        id: ID,
        customer_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        customer_name: "Ada",
        title: "Faucet",
        no_site: true,
        mode: "quote",
      }).ok,
    ).toBe(false);
  });

  it("lists every lifecycle for a customer only when that customer is selected", () => {
    const associated = parseJobListQuery({ customer_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    expect(associated.ok).toBe(true);
    if (associated.ok) {
      expect(associated.value.state).toBe("all");
      expect(associated.value.customer_id).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    }
    const jobsTab = parseJobListQuery({});
    expect(jobsTab.ok).toBe(true);
    if (jobsTab.ok) {
      expect(jobsTab.value.state).toBe("open");
      expect(jobsTab.value.customer_id).toBeNull();
    }
  });
});

describe("customer error status", () => {
  it("maps duplicate, referenced, and archived customers to 409", () => {
    expect(httpStatusForCode(API_ERROR_CODES.DUPLICATE_CUSTOMER_EMAIL)).toBe(409);
    expect(httpStatusForCode(API_ERROR_CODES.CUSTOMER_REFERENCED)).toBe(409);
    expect(httpStatusForCode(API_ERROR_CODES.CUSTOMER_ARCHIVED)).toBe(409);
  });
});
