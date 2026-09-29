import { analyticsPropertiesAreSafe } from "@job-to-invoice/schemas";
import { describe, expect, it } from "vitest";
import { clearCreateJobForm, holdCreateJobForm, peekCreateJobForm } from "../jobs/create-session.ts";
import { emptyJobForm } from "../jobs/form.ts";
import {
  CUSTOMER_EMAIL_REQUIRED,
  customerCreateFromForm,
  customerMutationDenied,
  customerPatchFromForm,
  emptyCustomerForm,
} from "./form.ts";
import {
  CUSTOMER_PRIMARY_MIN_PT,
  CUSTOMER_TARGET_MIN_PT,
  customerListAnnouncement,
  customerSubmitBlocked,
  formatBillingAddress,
  presentCreateAnyway,
  presentCreateCustomerDestination,
  presentCustomerList,
  presentDuplicateConfirmation,
} from "./presentation.ts";

describe("customer form", () => {
  it("sends postal_code and keeps Gmail local parts", () => {
    const parsed = customerCreateFromForm({
      ...emptyCustomerForm(),
      name: "José García",
      email: "a.b+tag@gmail.com",
      phone: "+12025550123",
      line1: "123 Main Street",
      city: "Austin",
      state: "TX",
      postal_code: "78701",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.normalized_email).toBe("a.b+tag@gmail.com");
      expect(parsed.value.billing_address?.postal_code).toBe("78701");
      expect(parsed.value.billing_address).not.toHaveProperty("zip");
    }
  });

  it("patches only changed fields", () => {
    const original = { ...emptyCustomerForm(), name: "Ada" };
    const parsed = customerPatchFromForm({ ...original, phone: "+12025550123" }, original);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.phone).toBe("+12025550123");
      expect(parsed.value).not.toHaveProperty("name");
    }
  });

  it("requires an email on create and keeps an empty phone off the request", () => {
    const missing = customerCreateFromForm({ ...emptyCustomerForm(), name: "Taylor Client" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.field_errors).toContainEqual({ field: "email", message: CUSTOMER_EMAIL_REQUIRED });
    }
    const invalid = customerCreateFromForm({ ...emptyCustomerForm(), name: "Taylor Client", email: "not-an-email" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.field_errors.some((item) => item.field === "email")).toBe(true);
    }
    const valid = customerCreateFromForm({
      ...emptyCustomerForm(),
      name: "Taylor Client",
      email: " A.B+Tag@Gmail.com ",
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.value.email).toBe("A.B+Tag@Gmail.com");
      expect(valid.value.normalized_email).toBe("a.b+tag@gmail.com");
      expect(valid.value.phone).toBeNull();
      expect(valid.value).not.toHaveProperty("phone", "");
    }
    const badPhone = customerCreateFromForm({
      ...emptyCustomerForm(),
      name: "Taylor Client",
      email: "taylor@example.com",
      phone: "123",
    });
    expect(badPhone.ok).toBe(false);
    if (!badPhone.ok) {
      expect(badPhone.field_errors.some((item) => item.field === "phone")).toBe(true);
    }
    const goodPhone = customerCreateFromForm({
      ...emptyCustomerForm(),
      name: "Taylor Client",
      email: "taylor@example.com",
      phone: "+12025550123",
    });
    expect(goodPhone.ok).toBe(true);
    if (goodPhone.ok) expect(goodPhone.value.phone).toBe("+12025550123");
  });

  it("confirms a duplicate email instead of inventing another customer", () => {
    const sheet = presentDuplicateConfirmation(
      [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Taylor Client", archived: false }],
      " taylor@example.com ",
    );
    expect(sheet).toMatchObject({
      name: "Taylor Client",
      email: "taylor@example.com",
      initials: "TC",
      createsNewCustomer: false,
    });
    expect(presentDuplicateConfirmation([], "taylor@example.com")).toBeNull();
    expect(presentCreateAnyway()).toEqual({ confirm_duplicate_email: true });
    const confirmed = customerCreateFromForm({
      ...emptyCustomerForm(),
      name: "Taylor Client",
      email: "taylor@example.com",
      confirm_duplicate_email: true,
    });
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) expect(confirmed.value.confirm_duplicate_email).toBe(true);
    expect(customerSubmitBlocked(true)).toBe(true);
    expect(customerSubmitBlocked(false)).toBe(false);
  });

  it("returns a created or existing customer to create job without clearing the held draft", () => {
    const job = presentCreateCustomerDestination({
      returnTo: "job",
      relatedJobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      customerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      customerName: "Taylor Client",
    });
    expect(job).toEqual({
      pathname: "/jobs/new",
      params: {
        customerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        customerName: "Taylor Client",
        relatedJobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    });
    expect(JSON.stringify(job)).not.toMatch(/email|phone|line1|postal/i);
    expect(
      presentCreateCustomerDestination({
        customerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        customerName: "Taylor Client",
      }),
    ).toEqual({ pathname: "/customers/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    clearCreateJobForm();
    holdCreateJobForm({
      ...emptyJobForm(),
      mode: "direct_invoice",
      title: "Porch repair",
      no_site: false,
      internal_notes: "Keep these notes",
      line1: "123 Main",
    });
    presentCreateCustomerDestination({
      returnTo: "job",
      relatedJobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      customerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      customerName: "Taylor Client",
    });
    expect(peekCreateJobForm()?.mode).toBe("direct_invoice");
    expect(peekCreateJobForm()?.title).toBe("Porch repair");
    expect(peekCreateJobForm()?.no_site).toBe(false);
    expect(peekCreateJobForm()?.internal_notes).toBe("Keep these notes");
    expect(peekCreateJobForm()?.line1).toBe("123 Main");
    clearCreateJobForm();
    expect(analyticsPropertiesAreSafe({ mode: "quote" })).toBe(true);
    expect(analyticsPropertiesAreSafe({ email: "taylor@example.com" })).toBe(false);
    expect(analyticsPropertiesAreSafe({ customer_name: "Taylor Client" })).toBe(false);
    expect(analyticsPropertiesAreSafe({ phone: "+12025550123" })).toBe(false);
    expect(analyticsPropertiesAreSafe({ line1: "123 Main" })).toBe(false);
  });

  it("denies customer mutations unless the owner is online", () => {
    expect(customerMutationDenied("authenticated")).toBe(false);
    expect(customerMutationDenied("offline_cached")).toBe(true);
    expect(customerMutationDenied("access_expired")).toBe(true);
  });
});

describe("customer list accessibility state", () => {
  it("keeps add hidden offline and announces loading", () => {
    expect(CUSTOMER_PRIMARY_MIN_PT).toBeGreaterThanOrEqual(48);
    expect(CUSTOMER_TARGET_MIN_PT).toBeGreaterThanOrEqual(44);
    const offline = presentCustomerList({
      authStatus: "offline_cached",
      loading: false,
      loadedOnce: false,
      customers: [],
    });
    expect(offline.kind).toBe("offline");
    expect(offline.showAdd).toBe(false);
    expect(customerListAnnouncement("loading")).toBe("Loading customers");
    expect(formatBillingAddress({ line1: "1 Main", city: "Austin", state: "TX", postal_code: "78701" })).toContain(
      "78701",
    );
  });
});
