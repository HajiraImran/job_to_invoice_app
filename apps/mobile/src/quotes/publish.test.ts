import { randomUUID as nodeRandomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({
  randomUUID: vi.fn(() => nodeRandomUUID()),
}));

import { presentQuoteReview } from "./presentation.ts";
import { beginConfirmedQuotePublish, executeConfirmedQuotePublish, quotePublishSuccessPath } from "./publish.ts";
import { jobDetailPath } from "../jobs/routes.ts";

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
});
