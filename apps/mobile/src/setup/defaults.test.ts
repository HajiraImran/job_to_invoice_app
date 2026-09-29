import { describe, expect, it } from "vitest";
import { TERMS_MAX, parseTaxPercentToBp, parseWorkspaceSetup } from "@job-to-invoice/schemas";
import { copy } from "../i18n/en.ts";
import { APP_JOBS_HREF } from "../session/logic.ts";
import { emptySetupForm, setupRequestFromForm, type SetupFormValues } from "./form.ts";
import {
  presentConfirmedTimezone,
  presentCustomDueInvalid,
  presentDefaultsScreen,
  presentDuePresetLabel,
  presentDuplicateSubmitBlocked,
  presentFirstInvalidField,
  presentOfflineMutationRejected,
  presentSavingAnnouncement,
  presentSetupFieldErrors,
  presentSetupProgress,
  presentSetupRouteDecision,
  presentTaxConfirmationRequired,
  presentTaxRateInvalid,
  presentTermsOverLimit,
  presentTimezoneFieldValue,
  presentTimezonePickerRows,
  setupAnalyticsPropertiesAreSafe,
} from "./presentation.ts";

function defaultsValues(overrides: Partial<SetupFormValues> = {}): SetupFormValues {
  return {
    ...emptySetupForm("owner@example.com", "America/Chicago"),
    business_name: "José's Handyman",
    legal_name: "José's Handyman LLC",
    contact_name: "José García",
    line1: "123 Main Street",
    city: "Austin",
    state: "TX",
    postal_code: "78701",
    trade: "handyman",
    tax_percent: "0",
    due_preset: "14",
    default_terms: "",
    ...overrides,
  };
}

const readyFlags = { timezoneConfirmed: true, taxZeroConfirmed: true, skipLogo: true };

describe("S06 timezone and defaults presentation", () => {
  it("exposes step 3 chrome and post-save jobs routing", () => {
    const screen = presentDefaultsScreen();
    expect(screen.stepLabel).toBe("Step 3 of 3");
    expect(screen.section).toBe("Timezone & defaults");
    expect(screen.percentLabel).toBe("100%");
    expect(screen.heading).toBe("Set your defaults");
    expect(screen.supportingText).toBe("Choose how dates, taxes, and payment terms appear on new invoices.");
    expect(screen.continueLabel).toBe("Save business setup");
    expect(screen.currencyValue).toBe("US dollar (USD)");
    expect(screen.currencyEditable).toBe(false);
    expect(screen.successHref).toBe(APP_JOBS_HREF);
    expect(screen.backStep).toBe(2);
    expect(presentSetupProgress(3)).toEqual({
      fraction: 1,
      percentLabel: "100%",
      section: copy.setupDefaultsSection,
    });
  });

  it("formats the collapsed timezone and keeps picker confirmation provisional", () => {
    expect(presentTimezoneFieldValue("Asia/Karachi", new Date("2026-01-15T12:00:00.000Z"))).toBe(
      "Asia/Karachi (UTC+05:00)",
    );
    const rows = presentTimezonePickerRows("America/Chicago", "karachi", "Asia/Karachi");
    expect(rows.some((row) => row.id === "Asia/Karachi")).toBe(true);
    expect(presentConfirmedTimezone("Europe/London", "America/Chicago")).toBe("Europe/London");
    expect(presentConfirmedTimezone(undefined, "America/Chicago")).toBe("America/Chicago");
  });

  it("validates tax, due presets, custom days, and optional terms", () => {
    expect(presentTaxRateInvalid("8.25")).toBe(false);
    expect(presentTaxRateInvalid("-1")).toBe(true);
    expect(presentTaxRateInvalid("8.255")).toBe(true);
    expect(presentTaxRateInvalid("abc")).toBe(true);
    expect(parseTaxPercentToBp("8.25")).toEqual({ ok: true, value: 825 });
    expect(presentTaxConfirmationRequired("0", false)).toBe(true);
    expect(presentTaxConfirmationRequired("8.25", false)).toBe(false);
    expect(presentDuePresetLabel("0")).toBe("On receipt");
    expect(presentCustomDueInvalid(defaultsValues({ due_preset: "custom", custom_due_days: "366" }))).toBe(true);
    expect(presentCustomDueInvalid(defaultsValues({ due_preset: "14" }))).toBe(false);
    expect(presentTermsOverLimit("x".repeat(TERMS_MAX + 1))).toBe(true);
    const flags = { timezoneConfirmed: true, taxZeroConfirmed: false, skipLogo: true };
    expect(presentSetupFieldErrors(defaultsValues({ tax_percent: "0" }), flags, 3).tax_zero_confirmed).toBeDefined();
    expect(presentFirstInvalidField(defaultsValues({ timezone: "EST" }), readyFlags, 3)).toBe("timezone");
  });

  it("retains form values after a failed save and blocks duplicate or offline queueing", () => {
    const values = defaultsValues({ default_terms: "Net 14.\nWarranty included." });
    const failed = setupRequestFromForm(values, { timezoneConfirmed: false, taxZeroConfirmed: true, skipLogo: true });
    expect(failed.ok).toBe(false);
    expect(values.default_terms).toBe("Net 14.\nWarranty included.");
    expect(presentDuplicateSubmitBlocked(true)).toBe(true);
    expect(presentOfflineMutationRejected()).toBe(true);
    expect(presentSavingAnnouncement(true)).toBe(copy.savingSetup);
  });

  it("protects the onboarding route and excludes terms from analytics", () => {
    expect(presentSetupRouteDecision({ status: "restoring" })).toEqual({ action: "hold" });
    expect(presentSetupRouteDecision({ status: "signed_out" }).action).toBe("replace");
    expect(presentSetupRouteDecision({ status: "authenticated", setupCompleted: false })).toEqual({ action: "stay" });
    expect(presentSetupRouteDecision({ status: "authenticated", setupCompleted: true })).toEqual({
      action: "replace",
      href: APP_JOBS_HREF,
    });
    expect(setupAnalyticsPropertiesAreSafe({ trade: "handyman" })).toBe(true);
    expect(setupAnalyticsPropertiesAreSafe({ default_terms: "Net 14" })).toBe(false);
  });

  it("builds a workspace payload with IANA timezone and integer tax basis points", () => {
    const parsed = setupRequestFromForm(defaultsValues({ tax_percent: "8.25", timezone: "Asia/Karachi" }), readyFlags);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.timezone).toBe("Asia/Karachi");
      expect(parsed.value.default_tax_bp).toBe(825);
      expect(parsed.value.default_due_days).toBe(14);
    }
    if (parsed.ok) {
      expect(parseWorkspaceSetup({ ...parsed.value, timezone: "EST" }).ok).toBe(false);
    }
  });
});
