import { formatUsdCents } from "@job-to-invoice/schemas";
import { describe, expect, it } from "vitest";
import {
  centsToDollarsInput,
  emptyQuoteLine,
  formFromDraft,
  liveTotals,
  moveLine,
  payloadFromForm,
  quotePublishBody,
  type QuoteDraftRecord,
} from "./form.ts";
import {
  presentDeliveryStatus,
  presentQuoteEditor,
  presentQuotePdf,
  presentQuotePdfRetry,
  presentQuoteReview,
  quoteActionLabel,
} from "./presentation.ts";
import { jobQuotePath, jobRequestPath } from "../jobs/routes.ts";

const F01_LINE = {
  client_line_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  description: "Labour hour",
  unit: "hour" as const,
  custom_unit_label: "",
  quantity: "2.5",
  unit_price: "100.00",
  discount: "10",
  tax_percent: "8.25",
};

describe("quote form money", () => {
  it("calculates F01 live totals with integer cents", () => {
    const live = liveTotals({
      notes: "Scope",
      terms: "Net 14.",
      expiry_days: "14",
      lines: [F01_LINE],
    });
    expect(live.ok).toBe(true);
    if (live.ok) {
      expect(live.totals.net_cents).toBe(24000);
      expect(live.totals.tax_cents).toBe(1980);
      expect(live.totals.total_cents).toBe(25980);
      expect(formatUsdCents(live.totals.total_cents)).toBe("$259.80");
    }
    expect(centsToDollarsInput(10000)).toBe("100");
  });

  it("rejects floats and allows empty drafts", () => {
    expect(payloadFromForm({ notes: "", terms: "", expiry_days: "14", lines: [] }).ok).toBe(true);
    const badPrice = liveTotals({
      notes: "",
      terms: "",
      expiry_days: "14",
      lines: [{ ...F01_LINE, unit_price: "19.999" }],
    });
    expect(badPrice.ok).toBe(false);
  });

  it("reorders lines without changing ids", () => {
    const second = { ...emptyQuoteLine("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), description: "Materials" };
    const moved = moveLine([F01_LINE, second], 0, 1);
    expect(moved[0]?.client_line_id).toBe(second.client_line_id);
    expect(moved[1]?.client_line_id).toBe(F01_LINE.client_line_id);
  });

  it("round-trips a saved draft into the editor form", () => {
    const draft: QuoteDraftRecord = {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      job_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      kind: "quote",
      draft_state: "editing",
      schema_version: 1,
      version: 2,
      notes: "Scope",
      terms: "Net 14.",
      expiry_days: 14,
      default_tax_bp: 0,
      currency: "USD",
      lines: [
        {
          client_line_id: F01_LINE.client_line_id,
          description: "Labour hour",
          unit: "hour",
          custom_unit_label: null,
          quantity: "2.500",
          unit_price_cents: 10000,
          discount_cents: 1000,
          tax_bp: 825,
          gross_cents: 25000,
          net_cents: 24000,
          tax_cents: 1980,
          total_cents: 25980,
        },
      ],
      net_cents: 24000,
      tax_cents: 1980,
      total_cents: 25980,
    };
    const form = formFromDraft(draft);
    expect(form.lines[0]?.quantity).toBe("2.5");
    expect(form.lines[0]?.unit_price).toBe("100");
    expect(form.lines[0]?.tax_percent).toBe("8.25");
    expect(payloadFromForm(form).ok).toBe(true);
  });
});

describe("quote editor states", () => {
  it("shows loading, offline, conflict, and create vs open", () => {
    expect(presentQuoteEditor({ authStatus: "authenticated", loading: true, saveStatus: "idle" }).kind).toBe("loading");
    expect(
      presentQuoteEditor({
        authStatus: "offline_cached",
        loading: false,
        error: { message: "offline", retryable: true, status: 0 },
        saveStatus: "offline",
      }).kind,
    ).toBe("offline");
    expect(
      presentQuoteEditor({
        authStatus: "authenticated",
        loading: false,
        draft: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        error: { message: "conflict", retryable: true, status: 409, code: "VERSION_CONFLICT" },
        saveStatus: "conflict",
      }).kind,
    ).toBe("conflict");
    expect(quoteActionLabel(false)).toBe("create");
    expect(quoteActionLabel(true)).toBe("open");
    expect(jobQuotePath("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(
      "/(tabs)/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/quote",
    );
  });

  it("presents review confirmation, success, offline, and failure states", () => {
    const preview = {
      draft_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      job_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      version: 2,
      preview_hash: "ab".repeat(32),
      preview_expires_at: "2026-09-15T12:10:00.000Z",
      schema_version: 1,
      number_label: "Draft",
      snapshot: {
        business: { business_name: "Quote Co", legal_name: "Quote Co LLC", contact_name: "Owner", contact_email: "o@example.com" },
        customer: { name: "Riley" },
        job: { title: "Faucet", no_site: true, site_address: null },
        notes: "Scope",
        terms: "Net 14.",
        expiry_days: 14,
        expiry_local_date: "2026-09-29",
        issue_date: "2026-09-15",
        lines: [],
        net_cents: 24000,
        tax_cents: 1980,
        total_cents: 25980,
        currency: "USD",
      },
    };
    expect(
      presentQuoteReview({ authStatus: "authenticated", loading: true, confirming: false, publishing: false }).kind,
    ).toBe("loading");
    expect(
      presentQuoteReview({
        authStatus: "offline_cached",
        loading: false,
        confirming: false,
        publishing: false,
      }).publishDisabled,
    ).toBe(true);
    expect(
      presentQuoteReview({
        authStatus: "authenticated",
        loading: false,
        confirming: true,
        publishing: false,
        preview,
      }).kind,
    ).toBe("confirming");
    expect(
      presentQuoteReview({
        authStatus: "authenticated",
        loading: false,
        confirming: false,
        publishing: false,
        published: {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          job_id: preview.job_id,
          number: "Q-000001",
          revision_label: "R1",
          revision_no: 1,
          lifecycle: "issued",
          pdf_state: "preparing",
          snapshot: preview.snapshot,
          net_cents: 24000,
          tax_cents: 1980,
          total_cents: 25980,
        },
      }).kind,
    ).toBe("published");
    expect(presentQuotePdf({ state: "preparing", url: null })).toEqual({
      kind: "preparing",
      showRetry: true,
    });
    expect(presentQuotePdf({ state: "ready", url: "https://r2.invalid/quote.pdf" })).toEqual({
      kind: "ready",
      url: "https://r2.invalid/quote.pdf",
      showRetry: false,
    });
    expect(presentQuotePdf({ state: "failed", url: null })).toEqual({
      kind: "failed",
      showRetry: true,
    });
    expect(presentQuotePdfRetry({ checking: true, stillPreparing: false })).toEqual({
      busy: true,
      label: "Checking…",
    });
    expect(presentQuotePdfRetry({ checking: false, stillPreparing: true })).toEqual({
      busy: false,
      label: "Try again",
      acknowledgement: "PDF is still being prepared",
    });
    expect(presentQuotePdfRetry({ checking: false, stillPreparing: false })).toEqual({
      busy: false,
      label: "Try again",
    });
    expect(
      presentQuoteReview({
        authStatus: "authenticated",
        loading: false,
        confirming: false,
        publishing: false,
        preview,
        error: { message: "stale", retryable: true, status: 409, code: "PREVIEW_CHANGED" },
      }).kind,
    ).toBe("conflict");
    expect(
      presentQuoteReview({
        authStatus: "authenticated",
        loading: false,
        confirming: false,
        publishing: false,
        error: { message: "paywall", retryable: false, status: 403, code: "ENTITLEMENT_REQUIRED" },
      }).kind,
    ).toBe("entitlement");
  });

  it("validates recipient email on publish and presents S12 delivery states", () => {
    expect(quotePublishBody("ab".repeat(32), "not-an-email").ok).toBe(false);
    expect(quotePublishBody("ab".repeat(32), "customer@example.com")).toEqual({
      ok: true,
      value: { preview_hash: "ab".repeat(32), recipient_email: "customer@example.com" },
    });
    expect(jobRequestPath("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(
      "/(tabs)/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/request",
    );
    const base = {
      authStatus: "authenticated",
      loading: false,
      checking: false,
      request: {
        request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        document_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        job_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        number: "Q-000001",
        revision_label: "R1",
        revision_no: 1,
        template_id: "EMAIL01",
        delivery_state: "queued",
        recipient_email_masked: "c***@example.com",
        last_event_at: "2026-09-16T00:00:00.000Z",
        retry_count: 0,
        retryable: true,
        terminal: false,
      },
    };
    expect(presentDeliveryStatus(base).kind).toBe("queued");
    expect(presentDeliveryStatus({ ...base, request: { ...base.request, delivery_state: "submitting" } }).kind).toBe(
      "sending",
    );
    const accepted = presentDeliveryStatus({
      ...base,
      request: { ...base.request, delivery_state: "accepted_by_provider" },
    });
    expect(accepted.kind).toBe("accepted");
    expect(accepted.kind).not.toBe("delivered");
    expect(accepted.acceptedNotDelivered).toBe(true);
    expect(accepted.label).toContain("not yet confirmed delivered");
    expect(presentDeliveryStatus({ ...base, request: { ...base.request, delivery_state: "delivered" } }).kind).toBe(
      "delivered",
    );
    expect(presentDeliveryStatus({ ...base, request: { ...base.request, delivery_state: "bounced" } }).kind).toBe(
      "bounced",
    );
    expect(presentDeliveryStatus({ ...base, request: { ...base.request, delivery_state: "complained" } }).kind).toBe(
      "complained",
    );
    expect(presentDeliveryStatus({ ...base, request: { ...base.request, delivery_state: "failed" } }).kind).toBe(
      "failed",
    );
    expect(presentDeliveryStatus({ ...base, loading: true, request: undefined }).kind).toBe("loading");
    expect(presentDeliveryStatus({ ...base, authStatus: "offline_cached" }).kind).toBe("offline");
    const retryBusy = presentDeliveryStatus({ ...base, checking: true });
    expect(retryBusy.retryBusy).toBe(true);
    expect(retryBusy.showRetry).toBe(true);
  });
});
