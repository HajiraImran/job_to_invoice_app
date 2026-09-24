import { describe, expect, it } from "vitest";
import { customerCreateFromForm, customerMutationDenied, customerPatchFromForm, emptyCustomerForm } from "./form.ts";
import {
  CUSTOMER_PRIMARY_MIN_PT,
  CUSTOMER_TARGET_MIN_PT,
  customerListAnnouncement,
  formatBillingAddress,
  presentCustomerList,
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
