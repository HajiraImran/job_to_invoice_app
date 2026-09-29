import { describe, expect, it } from "vitest";
import { JOB_TITLE_MAX, parseBoundedText } from "@job-to-invoice/schemas";
import { copy } from "../i18n/en.ts";
import {
  createJobAnalyticsPropertiesAreSafe,
  presentActiveCustomersOnly,
  presentCreateJobNextHref,
  presentCreateJobReady,
  presentCreateJobScreen,
  presentCustomerRowLabel,
  presentCustomerSecondary,
  presentDefaultCreateValues,
  presentDuplicateSubmitBlocked,
  presentCreateJobPrimaryColor,
  presentModeCards,
  presentPickerState,
  presentSiteFieldValue,
  presentTitleInvalid,
} from "./create-presentation.ts";
import { clearCreateJobForm, holdCreateJobForm, peekCreateJobForm } from "./create-session.ts";
import { emptyJobForm, jobRequestFromForm, type JobFormValues } from "./form.ts";
import { jobDetailPath, jobInvoicePath, jobQuotePath } from "./routes.ts";

function validOnline(overrides: Partial<JobFormValues> = {}): JobFormValues {
  return {
    ...emptyJobForm(),
    customer_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    customer_name: "Riley Chen",
    title: "Northside porch repair",
    no_site: true,
    mode: "quote",
    ...overrides,
  };
}

describe("S06 create job presentation", () => {
  it("defaults to quote mode and no site address", () => {
    const screen = presentCreateJobScreen();
    const defaults = presentDefaultCreateValues();
    expect(screen.heading).toBe("Create job");
    expect(screen.supportingText).toBe(copy.createJobSupport);
    expect(screen.defaultMode).toBe("quote");
    expect(screen.defaultNoSite).toBe(true);
    expect(screen.contactsPermission).toBe(false);
    expect(screen.contactImport).toBe(false);
    expect(defaults.mode).toBe("quote");
    expect(defaults.no_site).toBe(true);
    expect(presentModeCards("quote")[0]?.selected).toBe(true);
    expect(presentModeCards("direct_invoice")[1]?.selected).toBe(true);
    expect(presentModeCards("quote")[0]?.badge).toBe("Recommended");
    expect(presentCreateJobPrimaryColor()).toBe("#464B71");
    expect(presentSiteFieldValue(defaults)).toBe("No site address");
    expect(presentSiteFieldValue({ no_site: false, line1: "123 Main" })).toBe("123 Main");
  });

  it("enables continue only when required fields are valid and not submitting", () => {
    expect(presentCreateJobReady(emptyJobForm(), true, false)).toBe(false);
    expect(presentCreateJobReady(validOnline(), true, false)).toBe(true);
    expect(presentCreateJobReady(validOnline(), true, true)).toBe(false);
    expect(presentCreateJobReady(validOnline({ customer_id: "" }), true, false)).toBe(false);
    expect(
      presentCreateJobReady({ ...emptyJobForm(), customer_name: "Riley", title: "Porch", no_site: true, mode: "quote" }, false, false),
    ).toBe(true);
    expect(presentDuplicateSubmitBlocked(true)).toBe(true);
  });

  it("validates titles and keeps Unicode while rejecting controls", () => {
    expect(presentTitleInvalid("Northside porch repair")).toBe(false);
    expect(presentTitleInvalid("")).toBe(true);
    expect(presentTitleInvalid("x".repeat(JOB_TITLE_MAX + 1))).toBe(true);
    expect(parseBoundedText("  José's porch  ", { min: 1, max: JOB_TITLE_MAX })).toEqual({
      ok: true,
      value: "José's porch",
    });
    expect(parseBoundedText("Porch\u0007", { min: 1, max: JOB_TITLE_MAX }).ok).toBe(false);
    const values = validOnline({ title: "Porch\u0007" });
    expect(jobRequestFromForm(values, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", undefined, { savedCustomer: true }).ok).toBe(
      false,
    );
    expect(values.title).toBe("Porch\u0007");
  });

  it("routes quote and direct-invoice continuation and keeps offline on job detail", () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(presentCreateJobNextHref(id, "quote", true)).toBe(jobQuotePath(id));
    expect(presentCreateJobNextHref(id, "direct_invoice", true)).toBe(jobInvoicePath(id));
    expect(presentCreateJobNextHref(id, "quote", false)).toBe(jobDetailPath(id));
  });

  it("excludes archived customers and presents accessible picker rows", () => {
    const active = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "Riley Chen",
      email: "owner@example.com",
      phone: "+12025550123",
      billing_address: null,
      archived_at: null,
      version: 1,
      created_at: "2026-09-25T00:00:00.000Z",
      updated_at: "2026-09-25T00:00:00.000Z",
    };
    const archived = { ...active, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", archived_at: "2026-09-25T00:00:00.000Z" };
    expect(presentActiveCustomersOnly([active, archived])).toEqual([active]);
    expect(presentCustomerSecondary(active)).toBe("owner@example.com");
    expect(presentCustomerRowLabel(active)).toBe("Riley Chen, owner@example.com");
    const empty = presentPickerState({
      authStatus: "authenticated",
      loading: false,
      loadedOnce: true,
      customers: [],
    });
    expect(empty.kind).toBe("empty");
    const failed = presentPickerState({
      authStatus: "authenticated",
      loading: false,
      loadedOnce: true,
      customers: [],
      error: { message: copy.customersLoadError, retryable: true },
    });
    expect(failed.kind).toBe("error");
    expect(failed.showRetry).toBe(true);
    expect(presentPickerState({ authStatus: "offline_cached", loading: false, loadedOnce: false, customers: [] }).kind).toBe(
      "offline",
    );
  });

  it("holds create-job values across add-customer and does not reset on cancel", () => {
    clearCreateJobForm();
    const draft = validOnline({ title: "Keep this title", mode: "direct_invoice", no_site: false, line1: "123 Main" });
    holdCreateJobForm(draft);
    expect(peekCreateJobForm()?.title).toBe("Keep this title");
    expect(peekCreateJobForm()?.mode).toBe("direct_invoice");
    expect(peekCreateJobForm()?.line1).toBe("123 Main");
    const held = peekCreateJobForm();
    expect(held).toBeDefined();
    if (!held) return;
    const returned = { ...held, customer_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", customer_name: "New Co" };
    expect(returned.title).toBe("Keep this title");
    expect(returned.mode).toBe("direct_invoice");
    clearCreateJobForm();
    expect(peekCreateJobForm()).toBeUndefined();
  });

  it("keeps offline customer_name payloads and excludes PII from analytics", () => {
    const offline = jobRequestFromForm(
      { ...emptyJobForm(), customer_name: "Riley Chen", title: "Porch", no_site: true, mode: "quote" },
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(offline.ok).toBe(true);
    if (offline.ok) {
      expect(offline.value.customer_id).toBeNull();
      expect(offline.value.customer_id).not.toBe(offline.value.id);
      expect(offline.value.customer_name).toBe("Riley Chen");
    }
    expect(createJobAnalyticsPropertiesAreSafe({ mode: "quote" })).toBe(true);
    expect(createJobAnalyticsPropertiesAreSafe({ customer_name: "Riley Chen" })).toBe(false);
    expect(createJobAnalyticsPropertiesAreSafe({ job_title: "Porch" })).toBe(false);
    expect(createJobAnalyticsPropertiesAreSafe({ email: "owner@example.com" })).toBe(false);
  });
});
