import { analyticsPropertiesAreSafe, formatUsdCents } from "@job-to-invoice/schemas";
import { describe, expect, it } from "vitest";
import { jobDetailPath } from "../jobs/routes.ts";
import {
  presentApprovalReceipt,
  presentCalendarDate,
  presentDeliveryStatus,
  presentRequestActions,
  presentRequestActivity,
  presentRequestDetail,
  presentRequestTimestamp,
  requestIdempotencyAfterFailure,
  requestMutationAllowed,
  requestStateLabel,
} from "./presentation.ts";

describe("S12 request actions", () => {
  const pending = {
    request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    document_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    job_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    number: "Q-000001",
    revision_label: "R1",
    revision_no: 1,
    template_id: "EMAIL01",
    delivery_state: "delivered",
    recipient_email_masked: "c***@example.com",
    last_event_at: new Date().toISOString(),
    retry_count: 0,
    retryable: false,
    terminal: true,
    request_state: "pending",
    can_resend: true,
    can_withdraw: true,
    can_replace_link: true,
  };

  it("hides mutations when offline and never treats them as queueable", () => {
    const actions = presentRequestActions({ authStatus: "offline_cached", request: pending });
    expect(actions.resend).toBe("offline");
    expect(actions.withdraw).toBe("offline");
    expect(actions.replaceLink).toBe("offline");
  });

  it("disables resend while cooling down and hides actions after withdraw", () => {
    const cooling = presentRequestActions({
      authStatus: "authenticated",
      request: {
        ...pending,
        can_resend: false,
        resend_available_at: new Date(Date.now() + 60_000).toISOString(),
      },
      nowMs: Date.now(),
    });
    expect(cooling.resend).toBe("disabled");
    expect(cooling.withdraw).toBe("ready");
    const withdrawn = presentRequestActions({
      authStatus: "authenticated",
      request: { ...pending, request_state: "withdrawn", can_resend: false, can_withdraw: false, can_replace_link: false },
    });
    expect(withdrawn.resend).toBe("hidden");
    expect(requestStateLabel("withdrawn")).toMatch(/withdrew/i);
  });

  it("marks actions busy while a mutation is in flight", () => {
    const busy = presentRequestActions({ authStatus: "authenticated", request: pending, submitting: true });
    expect(busy.resend).toBe("busy");
    expect(busy.withdraw).toBe("busy");
    expect(busy.replaceLink).toBe("busy");
  });

  it("presents pending, failed delivery, and accepted states from server fields", () => {
    expect(presentRequestDetail(pending).badge).toBe("Pending approval");
    expect(presentRequestDetail({ ...pending, delivery_state: "failed" })).toMatchObject({
      badge: "Delivery failed",
      tone: "failed",
      deliveryFailed: true,
    });
    expect(presentRequestDetail({ ...pending, request_state: "approved", decided_at: "2026-09-26T12:04:00.000Z" })).toMatchObject({
      badge: "Accepted",
      accepted: true,
    });
    expect(presentRequestDetail({ ...pending, request_state: "withdrawn" }).badge).toMatch(/withdrew/i);
    expect(presentRequestDetail({ ...pending, request_state: "expired" }).badge).toMatch(/expired/i);
    expect(presentRequestDetail({ ...pending, request_state: "superseded" }).badge).toMatch(/newer version/i);
  });

  it("formats server cents and omits optional recipient or invented times", () => {
    expect(formatUsdCents(104000)).toBe("$1040.00");
    expect(presentRequestTimestamp(undefined)).toBeUndefined();
    expect(presentCalendarDate("2026-10-10")).toBe("Oct 10, 2026");
    expect(presentCalendarDate("not-a-date")).toBeUndefined();
    const activity = presentRequestActivity({
      ...pending,
      created_at: "2026-09-26T11:16:00.000Z",
      last_event_at: "2026-09-26T11:18:00.000Z",
      delivery_state: "delivered",
    });
    expect(activity.map((item) => item.title)).toEqual(["Request delivered", "Request created"]);
    expect(activity.every((item) => item.at || item.on)).toBe(true);
    expect(JSON.stringify(activity)).not.toMatch(/token|href|https:/i);
  });

  it("builds accepted activity only from decided_at and keeps the receipt hidden until a decision exists", () => {
    const accepted = presentRequestActivity({
      ...pending,
      request_state: "approved",
      decided_at: "2026-09-26T12:04:00.000Z",
      created_at: "2026-09-26T11:16:00.000Z",
    });
    expect(accepted[0]).toMatchObject({ title: "Customer accepted quote", at: "2026-09-26T12:04:00.000Z" });
    expect(presentApprovalReceipt({ requestState: "pending" }).visible).toBe(false);
    expect(presentApprovalReceipt({ requestState: "approved", decidedAt: "2026-09-26T12:04:00.000Z", pdfState: "preparing" })).toMatchObject({
      visible: true,
      pdf: "preparing",
    });
    expect(presentApprovalReceipt({ requestState: "approved", decidedAt: "2026-09-26T12:04:00.000Z", pdfState: "ready" }).pdf).toBe("ready");
    expect(presentApprovalReceipt({ requestState: "approved", decidedAt: "2026-09-26T12:04:00.000Z", pdfState: "failed" }).pdf).toBe("failed");
  });

  it("blocks duplicate, offline, and unauthorized mutations and reuses an idempotency key", () => {
    expect(requestMutationAllowed({ inFlight: true, offline: false, action: "ready" })).toBe(false);
    expect(requestMutationAllowed({ inFlight: false, offline: true, action: "ready" })).toBe(false);
    expect(requestMutationAllowed({ inFlight: false, offline: false, action: "disabled" })).toBe(false);
    expect(requestMutationAllowed({ inFlight: false, offline: false, action: "ready" })).toBe(true);
    expect(requestIdempotencyAfterFailure("RATE_LIMITED")).toBe("retain");
    expect(requestIdempotencyAfterFailure("OPERATION_PENDING")).toBe("retain");
    expect(requestIdempotencyAfterFailure(undefined)).toBe("retain");
    expect(requestIdempotencyAfterFailure("IDEMPOTENCY_MISMATCH")).toBe("rotate");
  });

  it("keeps a cached request available offline and hides it when access expires", () => {
    const offline = presentDeliveryStatus({
      authStatus: "offline_cached",
      loading: false,
      checking: false,
      request: pending,
    });
    expect(offline.kind).toBe("offline");
    expect(offline.label).toMatch(/offline/i);
    expect(
      presentDeliveryStatus({
        authStatus: "access_expired",
        loading: false,
        checking: false,
        request: pending,
      }).kind,
    ).toBe("access_expired");
    expect(jobDetailPath(pending.job_id)).toBe(`/(tabs)/jobs/${pending.job_id}`);
  });

  it("rejects recipient and token fields from request analytics properties", () => {
    const properties = { result: "delivered", template_id: "EMAIL01" };
    expect(analyticsPropertiesAreSafe(properties)).toBe(true);
    expect(analyticsPropertiesAreSafe({ recipient_email: "alex@example.com", template_id: "EMAIL01" })).toBe(false);
    expect(properties).not.toHaveProperty("recipient_email");
    expect(properties).not.toHaveProperty("token");
    expect(JSON.stringify(properties)).not.toMatch(/href|Bearer /i);
  });
});
