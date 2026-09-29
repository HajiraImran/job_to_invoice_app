import { describe, expect, it } from "vitest";
import { parseBoundedText, parseOptionalPhone, parseOwnerEmail, parseUsAddress } from "@job-to-invoice/schemas";
import { copy } from "../i18n/en.ts";
import { emptySetupForm, setupRequestFromForm, type SetupFormValues } from "./form.ts";
import { ONBOARDING_HREF } from "../session/logic.ts";
import {
  SETUP_HREF,
  presentAddressUsesPostalCode,
  presentAuthenticatedEmail,
  presentBasicInfoContinueEnabled,
  presentBasicInfoScreen,
  presentContinueLabel,
  presentDuplicateSubmitBlocked,
  presentEmailAccessibility,
  presentFieldAccessibility,
  presentFirstInvalidField,
  presentNationalPhoneRejected,
  presentNextInputName,
  presentOfflineMutationRejected,
  presentPartialAddressInvalid,
  presentSavingAnnouncement,
  presentSetupFieldErrors,
  presentSetupProgress,
  presentSetupRouteDecision,
  setupAnalyticsPropertiesAreSafe,
} from "./presentation.ts";

function basicValues(overrides: Partial<SetupFormValues> = {}): SetupFormValues {
  return {
    ...emptySetupForm("Owner.Plus+tag@Example.COM", "America/Chicago"),
    business_name: "José's Handyman",
    legal_name: "José's Handyman LLC",
    contact_name: "José García",
    contact_phone: "+12025550123",
    line1: "123 Main Street",
    line2: "Suite 4",
    city: "Austin",
    state: "tx",
    postal_code: "78701-1234",
    trade: "handyman",
    ...overrides,
  };
}

const flags = { timezoneConfirmed: true, taxZeroConfirmed: true, skipLogo: true };

describe("S04 basic info presentation", () => {
  it("exposes the onboarding route and continue destination without a branding screen", () => {
    const screen = presentBasicInfoScreen();
    expect(screen.route).toBe(SETUP_HREF);
    expect(screen.route).toBe("/(onboarding)/setup");
    expect(screen.heading).toBe("Tell us about your business");
    expect(screen.supportingText).toBe("These details appear on quotes and invoices.");
    expect(screen.continueLabel).toBe("Continue to branding");
    expect(screen.stepLabel).toBe("Step 1 of 3");
    expect(screen.percentLabel).toBe("33%");
    expect(screen.nextStep).toBe(2);
    expect(screen.emailEditable).toBe(false);
    expect(screen.persistOnContinue).toBe(false);
    expect(screen.settingsVisible).toBe(false);
  });

  it("validates business and contact names with trim, Unicode, and control rejection", () => {
    expect(parseBoundedText("  José's Handyman  ", { min: 2, max: 100 })).toEqual({
      ok: true,
      value: "José's Handyman",
    });
    expect(parseBoundedText("A", { min: 2, max: 100 }).ok).toBe(false);
    expect(parseBoundedText("AB\u0007C", { min: 2, max: 100 }).ok).toBe(false);
    expect(parseBoundedText("José García", { min: 2, max: 100 }).ok).toBe(true);
    const errors = presentSetupFieldErrors(basicValues({ business_name: "A", contact_name: "" }), flags, 1);
    expect(errors.business_name).toBeDefined();
    expect(errors.contact_name).toBeDefined();
  });

  it("prefills presentation email and does not rewrite plus or dots", () => {
    const screen = presentBasicInfoScreen();
    expect(screen.emailVerifiedLabel).toBe(copy.contactEmailVerified);
    const parsed = parseOwnerEmail("  Owner.Plus+tag@Example.COM ");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.display).toBe("Owner.Plus+tag@Example.COM");
      expect(parsed.normalized).toBe("owner.plus+tag@example.com");
    }
    const request = setupRequestFromForm(basicValues(), flags);
    expect(request.ok).toBe(true);
    if (request.ok) {
      expect(request.value.contact_email).toBe("Owner.Plus+tag@Example.COM");
    }
  });

  it("accepts E.164 phones, rejects national format, and allows a blank optional phone", () => {
    expect(parseOptionalPhone("+12025550123").ok).toBe(true);
    expect(parseOptionalPhone("5551234567").ok).toBe(false);
    expect(parseOptionalPhone("").ok).toBe(true);
    expect(presentNationalPhoneRejected("5551234567")).toBe(true);
    expect(presentNationalPhoneRejected("")).toBe(false);
    expect(presentSetupFieldErrors(basicValues({ contact_phone: "5551234567" }), flags, 1).contact_phone).toBeDefined();
    expect(presentSetupFieldErrors(basicValues({ contact_phone: "" }), flags, 1).contact_phone).toBeUndefined();
  });

  it("validates the US business address and uses postal_code in the payload", () => {
    expect(parseUsAddress({ line1: "123 Main", city: "Austin", state: "tx", postal_code: "78701" }).ok).toBe(true);
    expect(presentPartialAddressInvalid(basicValues({ city: "" }))).toBe(true);
    expect(presentSetupFieldErrors(basicValues({ state: "Texas" }), flags, 1)["address.state"]).toBeDefined();
    expect(presentSetupFieldErrors(basicValues({ postal_code: "7870" }), flags, 1)["address.postal_code"]).toBeDefined();
    expect(presentAddressUsesPostalCode(basicValues())).toBe(true);
    const parsed = setupRequestFromForm(basicValues(), flags);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.address.state).toBe("TX");
      expect(parsed.value.address.postal_code).toBe("78701-1234");
      expect(parsed.value.address.line2).toBe("Suite 4");
    }
    const withoutLine2 = setupRequestFromForm(basicValues({ line2: "" }), flags);
    expect(withoutLine2.ok).toBe(true);
  });

  it("retains form values after a failed continue and focuses the first invalid field", () => {
    const values = basicValues({ business_name: "A", line1: "" });
    const errors = presentSetupFieldErrors(values, flags, 1);
    expect(values.contact_name).toBe("José García");
    expect(presentFirstInvalidField(values, flags, 1)).toBe(Object.keys(errors)[0]);
    expect(presentBasicInfoContinueEnabled(false)).toBe(true);
    expect(presentBasicInfoContinueEnabled(true)).toBe(false);
  });

  it("excludes setup PII from analytics properties", () => {
    expect(setupAnalyticsPropertiesAreSafe({ acquisition_source: "unknown" })).toBe(true);
    expect(setupAnalyticsPropertiesAreSafe({ business_name: "José's Handyman" })).toBe(false);
    expect(setupAnalyticsPropertiesAreSafe({ email: "Owner.Plus+tag@Example.COM" })).toBe(false);
    expect(setupAnalyticsPropertiesAreSafe({ contact_phone: "+12025550123" })).toBe(false);
    expect(setupAnalyticsPropertiesAreSafe({ postal_code: "78701" })).toBe(false);
    expect(setupAnalyticsPropertiesAreSafe({ line1: "123 Main Street" })).toBe(false);
  });

  it("announces required, optional, verified email, saving, and keyboard order", () => {
    expect(presentFieldAccessibility(copy.businessName, true).accessibilityLabel).toContain(copy.setupRequired);
    expect(presentFieldAccessibility(copy.contactPhone, false).accessibilityLabel).toContain(copy.setupOptional);
    expect(presentEmailAccessibility(copy.contactEmail)).toMatchObject({
      editable: false,
      accessibilityState: { disabled: true },
    });
    expect(presentEmailAccessibility(copy.contactEmail).accessibilityLabel).toContain(copy.contactEmailVerified);
    expect(presentSavingAnnouncement(true)).toBe(copy.savingSetup);
    expect(presentNextInputName("business_name")).toBe("legal_name");
    expect(presentNextInputName("postal_code")).toBeUndefined();
    expect(presentContinueLabel(1, false)).toBe(copy.continueToBranding);
    expect(presentSetupProgress(1)).toEqual({ fraction: 0.33, percentLabel: "33%", section: copy.setupBasicInfo });
  });

  it("keeps Continue local on S04 and rejects offline queueing plus duplicate submit", () => {
    expect(presentBasicInfoScreen().persistOnContinue).toBe(false);
    expect(presentOfflineMutationRejected()).toBe(true);
    expect(presentDuplicateSubmitBlocked(true)).toBe(true);
    expect(presentBasicInfoContinueEnabled(true)).toBe(false);
    expect(presentAuthenticatedEmail("Owner.Plus+tag@Example.COM")).toBe("Owner.Plus+tag@Example.COM");
  });

  it("protects S04 until a restored authenticated session with incomplete setup", () => {
    expect(SETUP_HREF).toBe(ONBOARDING_HREF);
    expect(presentSetupRouteDecision({ status: "restoring" })).toEqual({ action: "hold" });
    expect(presentSetupRouteDecision({ status: "authenticating" })).toEqual({ action: "hold" });
    expect(presentSetupRouteDecision({ status: "signed_out" })).toEqual({
      action: "replace",
      href: "/(public)/welcome",
    });
    expect(presentSetupRouteDecision({ status: "awaiting_code" }).action).not.toBe("stay");
    expect(presentSetupRouteDecision({ status: "authenticated", setupCompleted: false })).toEqual({ action: "stay" });
    expect(presentSetupRouteDecision({ status: "authenticated", setupCompleted: true })).toEqual({
      action: "replace",
      href: "/(tabs)/jobs",
    });
  });

  it("rejects overlong address lines and control characters in contact name", () => {
    expect(parseBoundedText("x".repeat(151), { min: 1, max: 150 }).ok).toBe(false);
    expect(parseBoundedText("Suite 4", { min: 1, max: 150 }).ok).toBe(true);
    expect(parseBoundedText("José\u0001García", { min: 2, max: 100 }).ok).toBe(false);
    expect(presentSetupFieldErrors(basicValues({ contact_name: "José\u0001García" }), flags, 1).contact_name).toBeDefined();
  });
});
