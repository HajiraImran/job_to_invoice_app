import { randomUUID as nodeRandomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({
  randomUUID: vi.fn(() => nodeRandomUUID()),
}));

import { analyticsPropertiesAreSafe } from "@job-to-invoice/schemas";
import { copy } from "../i18n/en.ts";
import { jobDetailPath } from "../jobs/routes.ts";
import { subscriptionPath } from "../subscription/presentation.ts";
import {
  presentFrozenPreview,
  presentPreviewGeneratedLabel,
  presentQuotePdf,
  presentQuoteReview,
  previewAfterPublishError,
  previewHashIsCurrent,
  quotePublishPlansPath,
  type QuotePreviewRecord,
} from "./presentation.ts";
import { beginConfirmedQuotePublish, executeConfirmedQuotePublish, quotePublishSuccessPath } from "./publish.ts";

const DRAFT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PREVIEW = {
  draft_id: DRAFT_ID,
  job_id: JOB_ID,
  preview_hash: "ab".repeat(32),
  version: 4,
};

describe("confirmed quote publish", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends one POST to the draft publish path with a safe body and idempotency key", async () => {
    const inFlight = { current: false };
    const idempotencyKey = { current: undefined as string | undefined };
    const publish = vi.fn(async () => ({ ok: true as const, data: { number: "Q-000001" } }));
    const result = await executeConfirmedQuotePublish({
      confirming: true,
      preview: PREVIEW,
      recipientEmail: "customer@example.com",
      inFlight,
      idempotencyKey,
      publish,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]?.path).toBe(`/v1/drafts/${DRAFT_ID}/publish`);
    expect(result.requests[0]?.path).not.toContain(JOB_ID);
    expect(result.requests[0]?.method).toBe("POST");
    expect(result.requests[0]?.body).toEqual({
      preview_hash: PREVIEW.preview_hash,
      recipient_email: "customer@example.com",
    });
    expect(result.requests[0]?.body).not.toHaveProperty("token");
    expect(result.requests[0]?.body).not.toHaveProperty("href");
    expect(result.requests[0]?.ifMatch).toBe(4);
    expect(result.requests[0]?.idempotencyKey).toBe(idempotencyKey.current);
    expect(result.navigatedTo).toBe(jobDetailPath(JOB_ID));
    expect(result.publishedNumber).toBe("Q-000001");
    expect(result.stayedOnPublish).toBe(false);
    expect(JSON.stringify(result.requests[0]?.body)).not.toMatch(/token|href|Bearer /i);
  });

  it("makes no request when confirmation is cancelled", async () => {
    const publish = vi.fn(async () => ({ ok: true as const, data: { number: "Q-000001" } }));
    const result = await executeConfirmedQuotePublish({
      confirming: true,
      cancelled: true,
      preview: PREVIEW,
      recipientEmail: "customer@example.com",
      inFlight: { current: false },
      idempotencyKey: { current: undefined },
      publish,
    });
    expect(publish).not.toHaveBeenCalled();
    expect(result.requests).toEqual([]);
    expect(result.stayedOnPublish).toBe(true);
    expect(result.navigatedTo).toBeUndefined();
  });

  it("makes no request for an invalid email and keeps the publish screen", async () => {
    const publish = vi.fn(async () => ({ ok: true as const, data: { number: "Q-000001" } }));
    const result = await executeConfirmedQuotePublish({
      confirming: true,
      preview: PREVIEW,
      recipientEmail: "not-an-email",
      inFlight: { current: false },
      idempotencyKey: { current: undefined },
      publish,
    });
    expect(publish).not.toHaveBeenCalled();
    expect(result.feedback).toBe("invalid_email");
    expect(result.stayedOnPublish).toBe(true);
    expect(result.navigatedTo).toBeUndefined();
    expect(
      presentQuoteReview({
        authStatus: "authenticated",
        loading: false,
        confirming: true,
        publishing: false,
        preview: {
          ...PREVIEW,
          preview_expires_at: "2026-09-15T12:10:00.000Z",
          schema_version: 1,
          number_label: "Draft",
          snapshot: {
            business: { business_name: "Quote Co", legal_name: "Quote Co LLC", contact_name: "Owner", contact_email: "o@example.com" },
            customer: { name: "Riley" },
            job: { title: "Faucet", no_site: true, site_address: null },
            notes: "",
            terms: "",
            expiry_days: 14,
            expiry_local_date: "2026-09-29",
            issue_date: "2026-09-15",
            lines: [],
            net_cents: 0,
            tax_cents: 0,
            total_cents: 0,
            currency: "USD",
          },
        },
        error: { message: "Enter a valid customer email before publishing.", retryable: false, status: 422 },
      }),
    ).toMatchObject({ kind: "confirming", message: "Enter a valid customer email before publishing." });
  });

  it("does not publish from the review step", async () => {
    const publish = vi.fn(async () => ({ ok: true as const, data: { number: "Q-000001" } }));
    const result = await executeConfirmedQuotePublish({
      confirming: false,
      preview: PREVIEW,
      recipientEmail: "customer@example.com",
      inFlight: { current: false },
      idempotencyKey: { current: undefined },
      publish,
    });
    expect(publish).not.toHaveBeenCalled();
    expect(result.requests).toEqual([]);
    expect(result.stayedOnPublish).toBe(true);
  });

  it("ignores a duplicate tap while the first publish is in flight", async () => {
    const inFlight = { current: false };
    const first = beginConfirmedQuotePublish({
      confirming: true,
      preview: PREVIEW,
      recipientEmail: "customer@example.com",
      inFlight,
      idempotencyKey: undefined,
    });
    const duplicate = beginConfirmedQuotePublish({
      confirming: true,
      preview: PREVIEW,
      recipientEmail: "customer@example.com",
      inFlight,
      idempotencyKey: first.kind === "request" ? first.idempotencyKey : undefined,
    });
    expect(first.kind).toBe("request");
    expect(duplicate.kind).toBe("ignored");
    if (first.kind === "request" && duplicate.kind === "ignored") {
      expect(first.request.path).toBe(`/v1/drafts/${DRAFT_ID}/publish`);
      expect(first.request.idempotencyKey).toBeDefined();
    }
  });

  it("duplicate taps while the first request is pending issue one POST", async () => {
    let release!: (value: { ok: true; data: { number: string } }) => void;
    const pending = new Promise<{ ok: true; data: { number: string } }>((resolve) => {
      release = resolve;
    });
    const publish = vi.fn(() => pending);
    const inFlight = { current: false };
    const idempotencyKey = { current: undefined as string | undefined };
    const first = executeConfirmedQuotePublish({
      confirming: true,
      preview: PREVIEW,
      recipientEmail: "customer@example.com",
      inFlight,
      idempotencyKey,
      publish,
    });
    const second = await executeConfirmedQuotePublish({
      confirming: true,
      preview: PREVIEW,
      recipientEmail: "customer@example.com",
      inFlight,
      idempotencyKey,
      publish,
    });
    expect(second.requests).toEqual([]);
    expect(publish).toHaveBeenCalledTimes(1);
    release({ ok: true, data: { number: "Q-000001" } });
    const done = await first;
    expect(done.navigatedTo).toBe(jobDetailPath(JOB_ID));
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("does not navigate after an API failure", async () => {
    const publish = vi.fn(async () => ({ ok: false as const }));
    const result = await executeConfirmedQuotePublish({
      confirming: true,
      preview: PREVIEW,
      recipientEmail: "customer@example.com",
      inFlight: { current: false },
      idempotencyKey: { current: undefined },
      publish,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(result.feedback).toBe("api_error");
    expect(result.stayedOnPublish).toBe(true);
    expect(result.navigatedTo).toBeUndefined();
    expect(result.publishedNumber).toBeUndefined();
    expect(
      presentQuoteReview({
        authStatus: "authenticated",
        loading: false,
        confirming: true,
        publishing: false,
        preview: {
          ...PREVIEW,
          preview_expires_at: "2026-09-15T12:10:00.000Z",
          schema_version: 1,
          number_label: "Draft",
          snapshot: {
            business: { business_name: "Quote Co", legal_name: "Quote Co LLC", contact_name: "Owner", contact_email: "o@example.com" },
            customer: { name: "Riley" },
            job: { title: "Faucet", no_site: true, site_address: null },
            notes: "",
            terms: "",
            expiry_days: 14,
            expiry_local_date: "2026-09-29",
            issue_date: "2026-09-15",
            lines: [],
            net_cents: 0,
            tax_cents: 0,
            total_cents: 0,
            currency: "USD",
          },
        },
        error: { message: "Service unavailable.", retryable: true, status: 503, code: "UNAVAILABLE" },
      }).kind,
    ).toBe("confirming");
  });

  it("navigates to the job overview after success and no longer presents Draft", async () => {
    const result = await executeConfirmedQuotePublish({
      confirming: true,
      preview: PREVIEW,
      recipientEmail: "customer@example.com",
      inFlight: { current: false },
      idempotencyKey: { current: undefined },
      publish: async () => ({ ok: true, data: { number: "Q-000001" } }),
    });
    expect(result.navigatedTo).toBe(quotePublishSuccessPath(JOB_ID));
    expect(result.publishedNumber).not.toBe("Draft");
    expect(
      presentQuoteReview({
        authStatus: "authenticated",
        loading: false,
        confirming: false,
        publishing: false,
        published: {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          job_id: JOB_ID,
          number: "Q-000001",
          revision_label: "R1",
          revision_no: 1,
          lifecycle: "issued",
          pdf_state: "preparing",
          snapshot: {
            business: { business_name: "Quote Co", legal_name: "Quote Co LLC", contact_name: "Owner", contact_email: "o@example.com" },
            customer: { name: "Riley" },
            job: { title: "Faucet", no_site: true, site_address: null },
            notes: "",
            terms: "",
            expiry_days: 14,
            expiry_local_date: "2026-09-29",
            issue_date: "2026-09-15",
            lines: [],
            net_cents: 24000,
            tax_cents: 1980,
            total_cents: 25980,
            currency: "USD",
          },
          net_cents: 24000,
          tax_cents: 1980,
          total_cents: 25980,
        },
      }).kind,
    ).toBe("published");
  });

  it("reuses the same idempotency key after an ambiguous failure", async () => {
    const inFlight = { current: false };
    const idempotencyKey = { current: undefined as string | undefined };
    const first = await executeConfirmedQuotePublish({
      confirming: true,
      preview: PREVIEW,
      recipientEmail: "customer@example.com",
      inFlight,
      idempotencyKey,
      publish: async () => ({ ok: false as const }),
    });
    const second = await executeConfirmedQuotePublish({
      confirming: true,
      preview: PREVIEW,
      recipientEmail: "customer@example.com",
      inFlight,
      idempotencyKey,
      publish: async () => ({ ok: false as const }),
    });
    expect(first.requests[0]?.idempotencyKey).toBeTruthy();
    expect(second.requests[0]?.idempotencyKey).toBe(first.requests[0]?.idempotencyKey);
    expect(first.stayedOnPublish).toBe(true);
    expect(second.stayedOnPublish).toBe(true);
  });

  it("does not send a publish request for a cleared preview hash", () => {
    const started = beginConfirmedQuotePublish({
      confirming: true,
      preview: { ...PREVIEW, preview_hash: "" },
      recipientEmail: "customer@example.com",
      inFlight: { current: false },
      idempotencyKey: undefined,
    });
    expect(started.kind).not.toBe("request");
  });
});

const SNAPSHOT: QuotePreviewRecord["snapshot"] = {
  business: { business_name: "Northwind", legal_name: "Northwind LLC", contact_name: "Owner", contact_email: "owner@example.com" },
  customer: { name: "Riley Chen", email: "riley@example.com" },
  job: { title: "Kitchen valve", no_site: true, site_address: null },
  notes: "Gate code 12",
  terms: "Payment on completion",
  expiry_days: 14,
  expiry_local_date: "2026-10-10",
  issue_date: "2026-09-26",
  lines: [
    {
      position: 1,
      description: "Valve replacement",
      quantity: "2.000",
      unit: "item",
      custom_unit_label: null,
      unit_price_cents: 4000,
      discount_cents: 500,
      tax_bp: 825,
      net_cents: 7500,
      tax_cents: 619,
      total_cents: 8119,
    },
  ],
  net_cents: 7500,
  tax_cents: 619,
  total_cents: 8119,
  currency: "USD",
};

function reviewPreview(hash = "ab".repeat(32)): QuotePreviewRecord {
  return {
    ...PREVIEW,
    preview_hash: hash,
    preview_expires_at: "2026-09-26T16:10:00.000Z",
    schema_version: 1,
    number_label: "Draft",
    snapshot: SNAPSHOT,
  };
}

describe("quote preview presentation", () => {
  it("renders server line and document cents and withholds a final quote number", () => {
    const view = presentFrozenPreview(reviewPreview());
    expect(view.businessName).toBe("Northwind");
    expect(view.customerName).toBe("Riley Chen");
    expect(view.expiryDays).toBe(14);
    expect(view.unpublishedLabel).toBe(copy.previewNotPublished);
    expect(view).not.toHaveProperty("quoteNumber");
    expect(JSON.stringify(view)).not.toContain("Q-");
    expect(view.lines[0]).toMatchObject({
      description: "Valve replacement",
      quantity: "2.000",
      unit: "item",
      unitPriceCents: 4000,
      amountCents: 8119,
    });
    expect(view.subtotalCents).toBe(8000);
    expect(view.discountCents).toBe(500);
    expect(view.showDiscount).toBe(true);
    expect(view.netCents).toBe(7500);
    expect(view.taxCents).toBe(619);
    expect(view.totalCents).toBe(8119);
    expect(view.notes).toBe("Gate code 12");
    expect(view.terms).toBe("Payment on completion");
  });

  it("shows a generated label only for a real receipt time", () => {
    expect(presentPreviewGeneratedLabel(undefined, 1_000)).toBeUndefined();
    expect(presentPreviewGeneratedLabel(1_000, 20_000)).toBe(copy.previewGeneratedJustNow);
    expect(presentPreviewGeneratedLabel(1_000, 61_000)).toBeUndefined();
  });

  it("keeps publishing disabled while the preview is loading or the hash is missing", () => {
    expect(
      presentQuoteReview({
        authStatus: "authenticated",
        loading: true,
        confirming: false,
        publishing: false,
      }).kind,
    ).toBe("loading");
    expect(previewHashIsCurrent(undefined)).toBe(false);
    expect(previewHashIsCurrent({ preview_hash: "" })).toBe(false);
    expect(previewHashIsCurrent(reviewPreview())).toBe(true);
  });

  it("invalidates a stale hash and requires a new confirmation after refresh", () => {
    const current = reviewPreview();
    const stale = previewAfterPublishError(current, "PREVIEW_CHANGED");
    expect(stale?.preview_hash).toBe("");
    expect(previewHashIsCurrent(stale)).toBe(false);
    expect(
      presentQuoteReview({
        authStatus: "authenticated",
        loading: false,
        confirming: true,
        publishing: false,
        preview: stale,
        error: { message: copy.quoteStalePreview, retryable: true, status: 409, code: "PREVIEW_CHANGED" },
      }),
    ).toMatchObject({ kind: "conflict", publishDisabled: true });
    const refreshed = reviewPreview("cd".repeat(32));
    expect(previewHashIsCurrent(refreshed)).toBe(true);
    expect(refreshed.preview_hash).not.toBe(current.preview_hash);
    const reviewed = presentQuoteReview({
      authStatus: "authenticated",
      loading: false,
      confirming: false,
      publishing: false,
      preview: refreshed,
    });
    expect(reviewed).toMatchObject({ kind: "ready", publishDisabled: false });
    expect(
      beginConfirmedQuotePublish({
        confirming: false,
        preview: refreshed,
        recipientEmail: "riley@example.com",
        inFlight: { current: false },
        idempotencyKey: undefined,
      }).kind,
    ).toBe("ignored");
  });

  it("blocks publish for entitlement, offline, and access expiry", () => {
    const preview = reviewPreview();
    expect(
      presentQuoteReview({
        authStatus: "authenticated",
        loading: false,
        confirming: true,
        publishing: false,
        preview,
        error: { message: copy.quoteEntitlement, retryable: false, status: 402, code: "ENTITLEMENT_REQUIRED" },
      }),
    ).toMatchObject({ kind: "entitlement", publishDisabled: true });
    expect(quotePublishPlansPath()).toBe(`${subscriptionPath()}?from=publish`);
    expect(
      presentQuoteReview({
        authStatus: "authenticated",
        loading: false,
        confirming: false,
        publishing: false,
        preview,
      }).kind,
    ).toBe("ready");
    expect(
      presentQuoteReview({
        authStatus: "offline_cached",
        loading: false,
        confirming: false,
        publishing: false,
        preview,
      }),
    ).toMatchObject({ kind: "offline", publishDisabled: true });
    expect(
      presentQuoteReview({
        authStatus: "access_expired",
        loading: false,
        confirming: true,
        publishing: false,
        preview,
      }).kind,
    ).toBe("access_expired");
  });

  it("keeps recoverable publish failures on confirmation and leaves an issued PDF preparing", () => {
    const preview = reviewPreview();
    for (const code of ["RATE_LIMITED", "OPERATION_PENDING", "ASSET_NOT_READY", "UNAVAILABLE"]) {
      expect(
        presentQuoteReview({
          authStatus: "authenticated",
          loading: false,
          confirming: true,
          publishing: false,
          preview,
          error: { message: "Try again shortly.", retryable: code !== "ASSET_NOT_READY", status: 409, code },
        }).kind,
      ).toBe("confirming");
    }
    expect(presentQuotePdf({ state: "preparing", url: null })).toMatchObject({ kind: "preparing" });
    expect(presentQuotePdf({ state: "ready", url: "https://files.example/quote.pdf" }).kind).toBe("ready");
  });

  it("uses the documented document_published property names and rejects recipient details", () => {
    const properties = { kind: "quote", entitlement_origin: "free", line_count_bucket: "1-3" };
    expect(Object.keys(properties).sort()).toEqual(["entitlement_origin", "kind", "line_count_bucket"]);
    expect(analyticsPropertiesAreSafe(properties)).toBe(true);
    expect(analyticsPropertiesAreSafe({ recipient_email: "riley@example.com" })).toBe(false);
    expect(analyticsPropertiesAreSafe({ customer_name: "Riley", job_title: "Valve", terms: "Net 14" })).toBe(false);
    expect(properties).not.toHaveProperty("preview_hash");
    expect(properties).not.toHaveProperty("recipient_email");
  });

  it("exposes the preview and confirmation labels", () => {
    expect(copy.previewBack).toBe("Back to quote");
    expect(copy.previewContinue).toBe("Continue to publish");
    expect(copy.publishAndSend).toBe("Publish and send");
    expect(copy.previewRefresh).toBe("Refresh preview");
    expect(copy.publishUnavailable).toBe("Publish unavailable");
    expect(copy.viewPlans).toBe("View plans");
    expect(copy.notNow).toBe("Not now");
    expect(copy.previewNotPublished).toBe("Preview • Not published");
  });
});
