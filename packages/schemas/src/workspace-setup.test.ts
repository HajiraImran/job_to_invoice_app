import { describe, expect, it } from "vitest";
import { parseOptionalPhone } from "./phone.ts";
import { parseBoundedText } from "./text.ts";
import {
  calendarDateInTimeZone,
  isValidIanaTimeZone,
  naiveUtcMidnightCalendarDate,
} from "./timezone.ts";
import {
  parseDueDays,
  parseTaxBp,
  parseTaxPercentToBp,
  parseWorkspaceSetup,
  taxBpToPercentLabel,
} from "./workspace-setup.ts";
import { parseUsAddress } from "./address.ts";
import { isClientAnalyticsEvent, isServerOnlyAnalyticsEvent } from "./analytics.ts";
import { routeGroupFor } from "./auth-state.ts";

function validSetup(overrides: Record<string, unknown> = {}) {
  return {
    business_name: "José's Handyman",
    legal_name: "José's Handyman LLC",
    contact_name: "José García",
    contact_email: "Owner.Plus+tag@Example.COM",
    contact_phone: "+12025550123",
    address: {
      line1: "123 Main Street",
      line2: "Suite 4",
      city: "Austin",
      state: "TX",
      postal_code: "78701",
    },
    timezone: "America/Chicago",
    timezone_confirmed: true,
    trade: "handyman",
    default_tax_bp: 0,
    tax_zero_confirmed: true,
    default_due_days: 14,
    default_terms: "Payment is due according to the invoice.",
    skip_logo: true,
    ...overrides,
  };
}

describe("VAL01 names and email", () => {
  it("trims outer whitespace and preserves Unicode", () => {
    const parsed = parseWorkspaceSetup(validSetup({ business_name: "  José's Handyman  " }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.business_name).toBe("José's Handyman");
      expect(parsed.value.contact_email).toBe("Owner.Plus+tag@Example.COM");
    }
  });

  it("rejects control characters in names and preserves newlines only in terms", () => {
    expect(parseBoundedText("A\u0007B", { min: 2, max: 100 }).ok).toBe(false);
    expect(parseWorkspaceSetup(validSetup({ business_name: "AB\nC" })).ok).toBe(false);
    const terms = parseWorkspaceSetup(validSetup({ default_terms: "Net 14.\nThank you." }));
    expect(terms.ok).toBe(true);
  });

  it("enforces name length bounds", () => {
    expect(parseWorkspaceSetup(validSetup({ business_name: "A" })).ok).toBe(false);
    expect(parseWorkspaceSetup(validSetup({ business_name: "Ab" })).ok).toBe(true);
    expect(parseWorkspaceSetup(validSetup({ business_name: "A".repeat(101) })).ok).toBe(false);
    expect(parseWorkspaceSetup(validSetup({ legal_name: "A".repeat(151) })).ok).toBe(false);
    expect(parseWorkspaceSetup(validSetup({ contact_name: "A".repeat(101) })).ok).toBe(false);
  });

  it("does not rewrite plus or dots in email", () => {
    const parsed = parseWorkspaceSetup(validSetup());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.contact_email).toBe("Owner.Plus+tag@Example.COM");
    }
  });
});

describe("VAL01 phone", () => {
  it("allows empty phone and requires E.164 when present", () => {
    expect(parseOptionalPhone("")).toEqual({ ok: true, value: null });
    expect(parseOptionalPhone("+12025550123").ok).toBe(true);
    expect(parseOptionalPhone("2025550123").ok).toBe(false);
    expect(parseOptionalPhone("(202) 555-0123").ok).toBe(false);
    expect(parseWorkspaceSetup(validSetup({ contact_phone: "" })).ok).toBe(true);
  });
});

describe("VAL02 address", () => {
  it("accepts ZIP and ZIP+4 and two-letter states", () => {
    expect(parseUsAddress({ line1: "1 Main", city: "Miami", state: "FL", postal_code: "33101" }).ok).toBe(true);
    expect(parseUsAddress({ line1: "1 Main", city: "Miami", state: "FL", postal_code: "33101-1234" }).ok).toBe(true);
    expect(parseUsAddress({ line1: "1 Main", city: "Miami", state: "FL", postal_code: "3310" }).ok).toBe(false);
    expect(parseUsAddress({ line1: "1 Main", city: "Miami", state: "XX", postal_code: "33101" }).ok).toBe(false);
    expect(parseUsAddress({ line1: "1 Main", city: "Miami", state: "fl", postal_code: "33101" }).ok).toBe(true);
  });
});

describe("tax and due days", () => {
  it("stores integer basis points without floats", () => {
    expect(parseTaxPercentToBp("0")).toEqual({ ok: true, value: 0 });
    expect(parseTaxPercentToBp("8.25")).toEqual({ ok: true, value: 825 });
    expect(parseTaxPercentToBp("25")).toEqual({ ok: true, value: 2500 });
    expect(parseTaxPercentToBp("25.01").ok).toBe(false);
    expect(parseTaxBp(8.25).ok).toBe(false);
    expect(taxBpToPercentLabel(825)).toBe("8.25");
  });

  it("requires zero-tax confirmation and due-day bounds", () => {
    expect(parseWorkspaceSetup(validSetup({ default_tax_bp: 0, tax_zero_confirmed: false })).ok).toBe(false);
    expect(parseWorkspaceSetup(validSetup({ default_tax_bp: 725, tax_zero_confirmed: false })).ok).toBe(true);
    expect(parseDueDays(0).ok).toBe(true);
    expect(parseDueDays(365).ok).toBe(true);
    expect(parseDueDays(366).ok).toBe(false);
    expect(parseDueDays(14.5).ok).toBe(false);
  });
});

describe("timezone confirmation and INV10 date-only", () => {
  it("requires a confirmed IANA timezone", () => {
    expect(isValidIanaTimeZone("America/New_York")).toBe(true);
    expect(isValidIanaTimeZone("America/Los_Angeles")).toBe(true);
    expect(isValidIanaTimeZone("Not/AZone")).toBe(false);
    expect(parseWorkspaceSetup(validSetup({ timezone_confirmed: false })).ok).toBe(false);
    expect(parseWorkspaceSetup(validSetup({ timezone: "EST" })).ok).toBe(false);
  });

  it("keeps date-only values in US zones across a DST transition", () => {
    expect(calendarDateInTimeZone("2026-03-08", "America/New_York")).toBe("2026-03-08");
    expect(naiveUtcMidnightCalendarDate("2026-03-08", "America/New_York")).toBe("2026-03-07");
    expect(calendarDateInTimeZone("2026-11-01", "America/Los_Angeles")).toBe("2026-11-01");
    expect(naiveUtcMidnightCalendarDate("2026-11-01", "America/Los_Angeles")).toBe("2026-10-31");
  });
});

describe("setup request contract", () => {
  it("rejects unknown and ownership fields", () => {
    const parsed = parseWorkspaceSetup(validSetup({ owner_user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.field_errors.some((item) => item.field === "owner_user_id")).toBe(true);
    }
    expect(parseWorkspaceSetup(validSetup({ currency: "USD" })).ok).toBe(false);
    expect(parseWorkspaceSetup(validSetup({ workspace_id: "11111111-1111-4111-8111-111111111111" })).ok).toBe(false);
  });

  it("rejects unconfirmed timezone and missing logo skip", () => {
    expect(parseWorkspaceSetup(validSetup({ skip_logo: false })).ok).toBe(false);
  });
});

describe("onboarding route decision", () => {
  it("sends incomplete owners to S04 and completed owners to the app shell", () => {
    expect(routeGroupFor({ status: "authenticated", setupCompleted: false })).toBe("onboarding");
    expect(routeGroupFor({ status: "authenticated", setupCompleted: true })).toBe("app");
    expect(routeGroupFor({ status: "offline_cached", setupCompleted: false })).toBe("onboarding");
    expect(routeGroupFor({ status: "offline_cached", setupCompleted: true })).toBe("app");
    expect(routeGroupFor({ status: "bootstrap_error" })).toBe("verify");
  });
});

describe("analytics privacy", () => {
  it("treats onboarding_completed and job_created as server-only events", () => {
    expect(isServerOnlyAnalyticsEvent("onboarding_completed")).toBe(true);
    expect(isClientAnalyticsEvent("onboarding_completed")).toBe(false);
    expect(isServerOnlyAnalyticsEvent("job_created")).toBe(true);
    expect(isClientAnalyticsEvent("job_created")).toBe(false);
  });
});
