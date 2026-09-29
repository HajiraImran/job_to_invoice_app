import { parseChangeDraft } from "@job-to-invoice/schemas";
import { formatUsdCents } from "@job-to-invoice/schemas";
import { describe, expect, it } from "vitest";
import {
  beginChangePreviewRequest,
  beginChangePublishRequest,
  changeCustomerEmailPatch,
  changePreviewAfterFailure,
  changePreviewPublishes,
  changePublishFollowUp,
  changeRecipientPlan,
  presentChangeRecipient,
  changeStatusLabel,
  extraWorkAnalyticsProperties,
  extraWorkContinueDestination,
  extraWorkDiscountSupported,
  extraWorkEmailSavePlan,
  extraWorkEmailSavePublishes,
  extraWorkFieldErrors,
    extraWorkLoadPlan,
  extraWorkPdfAccessPlan,
  extraWorkReturnAfterSendPlan,
  presentExtraWorkPublished,
  reductionLoadPlan,
  createExtraWorkSaveGate,
  extraWorkIdempotencyAfterFailure,
  extraWorkPayload,
  saveExtraWorkUntilQuiet,
  extraWorkPreviewAllowed,
  extraWorkResponseIsCurrent,
  extraWorkReviewBlocked,
  extraWorkSaveLabel,
  extraWorkTotals,
  formatDeductionCents,
  presentBlockedChangePublish,
  presentChangeCustomerPreview,
  presentChangeEditor,
  presentChangeOperation,
  presentChangePublishResponse,
  resolveChangeEditorSession,
  reductionAnalyticsProperties,
  reductionContinueDestination,
  reductionDiscountSupported,
  reductionDraftIsCompatible,
  reductionFieldErrors,
  reductionIdempotencyAfterFailure,
  reductionPayload,
  reductionPreviewAllowed,
  reductionResponseIsCurrent,
  reductionReviewBlocked,
  reductionTaxIsCalculated,
  reductionTotals,
  subtractReductionCents,
  type ChangeDraftRecord,
  type ChangeSource,
  type ExtraWorkLineForm,
} from "./presentation.ts";

const draft: ChangeDraftRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  job_id: "22222222-2222-4222-8222-222222222222",
  kind: "change",
  draft_state: "editing",
  version: 1,
  reason: "Extra handle",
  expected_scope_version: 1,
  expiry_days: 14,
  additions: [],
  reductions: [],
  sources: [],
  previous_total_cents: 25980,
  change_including_tax_cents: 0,
  new_agreed_total_cents: 25980,
  default_tax_bp: 0,
};

describe("change editor presentation", () => {
  it("shows loading, empty, offline, blocked and retry states", () => {
    expect(presentChangeEditor({ authStatus: "authenticated", loading: true }).kind).toBe("loading");
    expect(presentChangeEditor({ authStatus: "authenticated", loading: false, draft }).kind).toBe("empty");
    expect(presentChangeEditor({ authStatus: "offline_cached", loading: false }).kind).toBe("offline");
    expect(
      presentChangeEditor({
        authStatus: "authenticated",
        loading: false,
        error: { message: "blocked", retryable: false, status: 422, code: "VALIDATION_FAILED" },
      }).kind,
    ).toBe("blocked");
    expect(
      presentChangeEditor({
        authStatus: "authenticated",
        loading: false,
        error: { message: "down", retryable: true, status: 0 },
      }).showRetry,
    ).toBe(true);
    expect(
      presentChangeEditor({
        authStatus: "authenticated",
        loading: false,
        draft: {
          ...draft,
          additions: [
            {
              client_line_id: "33333333-3333-4333-8333-333333333333",
              description: "Handle",
              unit: "item",
              custom_unit_label: null,
              quantity: "1",
              unit_price_cents: 1000,
              discount_cents: 0,
              tax_bp: 0,
            },
          ],
        },
      }).kind,
    ).toBe("loaded");
  });

  it("labels pending, approved and declined change orders", () => {
    expect(changeStatusLabel("issued", "pending")).toContain("pending");
    expect(changeStatusLabel("accepted", "approved")).toContain("approved");
    expect(changeStatusLabel("declined", "declined")).toContain("declined");
  });

  it("reloads a sent change instead of opening a new draft, and never publishes from email save", () => {
    const jobId = draft.job_id;
    const sent = resolveChangeEditorSession({
      intent: "extra",
      latestChange: { id: "7be2b825-7ec5-487b-9274-d1b38f0acbf0", lifecycle: "issued", request_state: "pending" },
      changeDraft: { id: draft.id, additionsCount: 0, reductionsCount: 0 },
    });
    expect(sent).toEqual({
      kind: "published",
      changeId: "7be2b825-7ec5-487b-9274-d1b38f0acbf0",
      lifecycle: "issued",
      request_state: "pending",
    });
    expect(extraWorkLoadPlan(sent, jobId).map((row) => `${row.method} ${row.path}`)).toEqual([
      `GET /v1/jobs/${jobId}`,
      "GET /v1/documents/7be2b825-7ec5-487b-9274-d1b38f0acbf0",
      "GET /v1/documents/7be2b825-7ec5-487b-9274-d1b38f0acbf0/download",
    ]);
    expect(
      resolveChangeEditorSession({
        intent: "extra",
        latestChange: { id: "7be2b825-7ec5-487b-9274-d1b38f0acbf0", lifecycle: "accepted", request_state: "approved" },
        changeDraft: { id: draft.id, additionsCount: 0, reductionsCount: 0 },
      }).kind,
    ).toBe("published");
    expect(
      resolveChangeEditorSession({
        intent: "reduce",
        latestChange: { id: "7be2b825-7ec5-487b-9274-d1b38f0acbf0", lifecycle: "accepted", request_state: "approved" },
        changeDraft: { id: draft.id, additionsCount: 0, reductionsCount: 0 },
      }).kind,
    ).toBe("resume");
    expect(
      resolveChangeEditorSession({
        intent: "extra",
        latestChange: null,
        changeDraft: null,
      }).kind,
    ).toBe("start");
    expect(extraWorkLoadPlan({ kind: "start" }, jobId).map((row) => row.method)).toEqual(["GET", "POST"]);
    expect(extraWorkReturnAfterSendPlan(jobId)).toEqual([{ method: "GET", path: `/v1/jobs/${jobId}` }]);
    expect(extraWorkPdfAccessPlan("7be2b825-7ec5-487b-9274-d1b38f0acbf0")).toEqual([
      { method: "GET", path: "/v1/documents/7be2b825-7ec5-487b-9274-d1b38f0acbf0/download" },
    ]);
    const pendingView = presentExtraWorkPublished({
      number: "CO-000001",
      revision_no: 1,
      lifecycle: "issued",
      request_state: "pending",
      additions: [{ description: "Hjk", total_cents: 10000 }],
    });
    expect(pendingView.status).toContain("pending");
    expect(pendingView.canStartAnother).toBe(false);
    expect(pendingView.lines).toEqual([{ description: "Hjk", amount: "$100.00" }]);
    const approvedView = presentExtraWorkPublished({
      number: "CO-000001",
      revision_no: 1,
      lifecycle: "accepted",
      request_state: "approved",
      additions: [{ description: "Hjk", total_cents: 10000 }],
    });
    expect(approvedView.status).toContain("approved");
    expect(approvedView.canStartAnother).toBe(true);
    expect(reductionLoadPlan(sent, jobId).map((row) => `${row.method} ${row.path}`)).toEqual([
      `GET /v1/jobs/${jobId}`,
    ]);
    expect(reductionLoadPlan({ kind: "resume" }, jobId).map((row) => row.method)).toEqual(["GET", "POST"]);
    expect(extraWorkEmailSavePublishes()).toBe(false);
    expect(changePreviewPublishes()).toBe(false);
    expect(
      extraWorkEmailSavePlan("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", draft.id).some(
        (row) => row.path.includes("/publish") || (row.method === "POST" && row.path.endsWith("/changes")),
      ),
    ).toBe(false);
    expect(beginChangePublishRequest({ confirming: false, preview: undefined, inFlight: { current: false } }).kind).toBe(
      "ignored",
    );
  });
});

const lineId = "33333333-3333-4333-8333-333333333333";
const secondLineId = "44444444-4444-4444-8444-444444444444";

function line(overrides: Partial<ExtraWorkLineForm> = {}): ExtraWorkLineForm {
  return {
    client_line_id: lineId,
    description: "Additional timber framing",
    quantity: "2",
    unit: "hour",
    unit_price: "85.00",
    tax_percent: "0",
    ...overrides,
  };
}

describe("extra work editor", () => {
  it("restores totals from server cents and valid draft lines", () => {
    const totals = extraWorkTotals(104000, [line(), line({ client_line_id: secondLineId, description: "Sealant", quantity: "3", unit: "item", unit_price: "30.00" })]);
    expect(totals).toEqual({ acceptedCents: 104000, extraCents: 26000, revisedCents: 130000 });
    expect(formatUsdCents(totals?.acceptedCents ?? 0)).toBe("$1040.00");
  });

  it("keeps an empty draft from review and preserves line order", () => {
    expect(extraWorkFieldErrors({ reason: "", expectedScopeVersion: 1, expiryDays: 14, lines: [] })[0]?.field).toBe("additions");
    expect(extraWorkReviewBlocked({ offline: false, busy: false, accessExpired: false, lineCount: 0, fieldErrorCount: 1 })).toBe(true);
    const payload = extraWorkPayload({
      reason: "Site found more work",
      expectedScopeVersion: 2,
      expiryDays: 14,
      lines: [line(), line({ client_line_id: secondLineId, description: "Sealant" })],
    });
    expect(payload.additions.map((item) => item.client_line_id)).toEqual([lineId, secondLineId]);
  });

  it("rejects missing, control, long, quantity, unit, price, tax and discount problems", () => {
    const base = { reason: "Site found more work", expectedScopeVersion: 1, expiryDays: 14 };
    expect(extraWorkFieldErrors({ ...base, lines: [line({ description: "  " })] }).some((error) => error.field.includes("description"))).toBe(true);
    expect(extraWorkFieldErrors({ ...base, lines: [line({ description: "Bad\u0001line" })] }).some((error) => error.field.includes("description"))).toBe(true);
    expect(extraWorkFieldErrors({ ...base, lines: [line({ description: "a".repeat(501) })] }).some((error) => error.field.includes("description"))).toBe(true);
    expect(extraWorkFieldErrors({ ...base, lines: [line({ quantity: "0" })] }).some((error) => error.field.includes("quantity"))).toBe(true);
    expect(extraWorkFieldErrors({ ...base, lines: [line({ quantity: "-1" })] }).some((error) => error.field.includes("quantity"))).toBe(true);
    expect(extraWorkFieldErrors({ ...base, lines: [line({ unit: "each" })] }).some((error) => error.field.includes("unit"))).toBe(true);
    expect(extraWorkFieldErrors({ ...base, lines: [line({ unit_price: "0.00" })] }).some((error) => error.field.includes("unit_price"))).toBe(true);
    expect(extraWorkFieldErrors({ ...base, lines: [line({ unit_price: "-5" })] }).some((error) => error.field.includes("unit_price"))).toBe(true);
    expect(extraWorkFieldErrors({ ...base, lines: [line({ tax_percent: "101" })] }).some((error) => error.field.includes("tax"))).toBe(true);
    const discounted = parseChangeDraft({
      reason: "Site found more work",
      expected_scope_version: 1,
      expiry_days: 14,
      additions: [{ ...extraWorkPayload({ ...base, lines: [line()] }).additions[0], discount_cents: -1 }],
      reductions: [],
    });
    expect(discounted.ok).toBe(false);
    expect(extraWorkDiscountSupported()).toBe(false);
  });

  it("rebases an overlapping save onto the version that save advanced without duplicating the line", async () => {
    const server = { version: 1, lines: [] as string[] };
    const stored = new Map<string, string>();
    let current = "partial";
    let keys = 0;
    const result = await createExtraWorkSaveGate()(() =>
      saveExtraWorkUntilQuiet({
        version: 1,
        savedFingerprint: "",
        readFingerprint: () => current,
        createKey: () => `key-${(keys += 1)}`,
        send: async (request) => {
          if (request.fingerprint === "partial") {
            current = "hello:10000";
          }
          const hash = `${request.ifMatch}:${request.fingerprint}`;
          const previous = stored.get(request.idempotencyKey);
          if (previous && previous !== hash) {
            return { ok: false, status: 409, code: "IDEMPOTENCY_MISMATCH" };
          }
          if (previous) {
            return { ok: true, version: server.version };
          }
          if (request.ifMatch !== server.version) {
            return { ok: false, status: 409, code: "VERSION_CONFLICT" };
          }
          server.version += 1;
          server.lines = [request.fingerprint];
          stored.set(request.idempotencyKey, hash);
          return { ok: true, version: server.version };
        },
      }),
    );
    expect(result.conflict).toBeUndefined();
    expect(result.requests.map((request) => request.ifMatch)).toEqual([1, 2]);
    expect(result.requests[0]?.idempotencyKey).not.toBe(result.requests[1]?.idempotencyKey);
    expect(result.requests.map((request) => request.fingerprint)).toEqual(["partial", "hello:10000"]);
    expect(server.lines).toEqual(["hello:10000"]);
    expect(server.version).toBe(3);
  });

  it("does not start a second extra-work save while the first is still running", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = createExtraWorkSaveGate();
    const first = gate(async () => {
      order.push("first");
      await blocked;
      order.push("first-done");
    });
    const second = gate(async () => {
      order.push("second");
    });
    await Promise.resolve();
    expect(order).toEqual(["first"]);
    release();
    await first;
    await second;
    expect(order).toEqual(["first", "first-done", "second"]);
  });

  it("keeps a genuine version conflict and does not write a second line", async () => {
    const server = { version: 2, lines: ["hello:10000"] };
    const result = await saveExtraWorkUntilQuiet({
      version: 1,
      savedFingerprint: "",
      readFingerprint: () => "hello:10000:edited",
      createKey: () => "key-new",
      send: async (request) => {
        if (request.ifMatch !== server.version) {
          return { ok: false, status: 409, code: "VERSION_CONFLICT" };
        }
        server.version += 1;
        server.lines.push(request.fingerprint);
        return { ok: true, version: server.version };
      },
    });
    expect(result.conflict).toEqual({ status: 409, code: "VERSION_CONFLICT" });
    expect(result.requests).toEqual([{ ifMatch: 1, idempotencyKey: "key-new", fingerprint: "hello:10000:edited" }]);
    expect(server).toEqual({ version: 2, lines: ["hello:10000"] });
  });

  it("reuses an idempotency key until mismatch and ignores stale generations", () => {
    expect(extraWorkIdempotencyAfterFailure("key-1", "VERSION_CONFLICT")).toBe("key-1");
    expect(extraWorkIdempotencyAfterFailure("key-1", "IDEMPOTENCY_MISMATCH")).toBeUndefined();
    expect(extraWorkResponseIsCurrent(2, 3)).toBe(false);
    expect(extraWorkResponseIsCurrent(3, 3)).toBe(true);
  });

  it("blocks offline preview, hides expired access, and keeps analytics empty", () => {
    expect(extraWorkPreviewAllowed({ offline: true, accessExpired: false, reviewBlocked: false })).toBe(false);
    expect(presentChangeEditor({ authStatus: "access_expired", loading: false, draft }).draft).toBeUndefined();
    expect(presentChangeEditor({ authStatus: "authenticated", loading: false, error: { message: "Request was not found.", retryable: false, status: 404 } }).message).toBe("Request was not found.");
    expect(extraWorkContinueDestination(draft.job_id)).toContain("/jobs/");
    expect(extraWorkAnalyticsProperties()).toEqual({});
    expect(extraWorkSaveLabel("saved")).toBe("Saved");
    expect(extraWorkSaveLabel("offline")).toBe("Offline");
    expect(extraWorkSaveLabel("failed")).toBe("Save failed");
  });
});

const sourceId = "55555555-5555-4555-8555-555555555555";
const sourceTwo = "66666666-6666-4666-8666-666666666666";

function source(overrides: Partial<ChangeSource> = {}): ChangeSource {
  return {
    source_line_id: sourceId,
    description: "Timber framing",
    original_net_cents: 100000,
    original_tax_cents: 0,
    remaining_net_cents: 100000,
    remaining_tax_cents: 0,
    ...overrides,
  };
}

describe("reduction editor", () => {
  it("separates reduction drafts from extra work and restores positive credits", () => {
    expect(reductionDraftIsCompatible({ kind: "change", additions: [] })).toBe(true);
    expect(reductionDraftIsCompatible({ kind: "change", additions: [{ client_line_id: lineId }] })).toBe(false);
    expect(reductionDraftIsCompatible({ kind: "quote", additions: [] })).toBe(false);
    const payload = reductionPayload({
      reason: "Customer removed allowance",
      expectedScopeVersion: 2,
      expiryDays: 14,
      amounts: [
        { source_line_id: sourceId, amount: "50.00" },
        { source_line_id: sourceTwo, amount: "10.00" },
      ],
    });
    expect(payload.additions).toEqual([]);
    expect(payload.reductions.map((line) => line.source_line_id)).toEqual([sourceId, sourceTwo]);
    expect(payload.reductions[0]?.net_credit_cents).toBe(5000);
  });

  it("subtracts integer cents and rejects an excessive or zero reduction", () => {
    const taxed = source({ original_net_cents: 10000, original_tax_cents: 800, remaining_net_cents: 10000, remaining_tax_cents: 800 });
    expect(reductionTotals({ previousCents: 10800, sources: [taxed], amounts: [{ source_line_id: sourceId, amount: "50.00" }] })).toEqual({
      acceptedCents: 10800,
      reductionCents: 5400,
      revisedCents: 5400,
      exceedsAccepted: false,
    });
    expect(reductionTotals({ previousCents: 100000, sources: [source()], amounts: [{ source_line_id: sourceId, amount: "1000.00" }] })?.revisedCents).toBe(0);
    expect(reductionTotals({ previousCents: 100000, sources: [source()], amounts: [{ source_line_id: sourceId, amount: "999.99" }] })?.revisedCents).toBe(1);
    const over = reductionTotals({ previousCents: 100000, sources: [source()], amounts: [{ source_line_id: sourceId, amount: "1000.01" }] });
    expect(over?.exceedsAccepted).toBe(true);
    expect(over?.revisedCents).toBe(-1);
    expect(subtractReductionCents(104000, 124000)).toEqual({
      acceptedCents: 104000,
      reductionCents: 124000,
      revisedCents: -20000,
      exceedsAccepted: true,
    });
    expect(formatDeductionCents(26000)).toBe("−$260.00");
    expect(reductionTotals({ previousCents: 100000, sources: [source()], amounts: [] })?.reductionCents).toBe(0);
    expect(reductionFieldErrors({ reason: "", expectedScopeVersion: 1, expiryDays: 14, sources: [source()], amounts: [] })[0]?.field).toBe("reductions");
    expect(reductionReviewBlocked({ offline: false, busy: false, accessExpired: false, incompatible: false, fieldErrorCount: 1, lineCount: 0 })).toBe(true);
  });

  it("rejects a short reason, control characters, and an incompatible save", () => {
    const base = { expectedScopeVersion: 1, expiryDays: 14, sources: [source()], amounts: [{ source_line_id: sourceId, amount: "10.00" }] };
    expect(reductionFieldErrors({ ...base, reason: "No" }).some((error) => error.field === "reason")).toBe(true);
    expect(reductionFieldErrors({ ...base, reason: "a".repeat(501) }).some((error) => error.field === "reason")).toBe(true);
    expect(reductionFieldErrors({ ...base, reason: "Bad\u0001reason" }).some((error) => error.field === "reason")).toBe(true);
    expect(reductionFieldErrors({ ...base, reason: "Customer removed allowance", amounts: [{ source_line_id: sourceId, amount: "0.00" }] }).length).toBeGreaterThan(0);
    expect(reductionIdempotencyAfterFailure("key-1", "VERSION_CONFLICT")).toBe("key-1");
    expect(reductionIdempotencyAfterFailure("key-1", "IDEMPOTENCY_MISMATCH")).toBeUndefined();
    expect(reductionResponseIsCurrent(1, 2)).toBe(false);
    expect(reductionPreviewAllowed({ offline: true, accessExpired: false, reviewBlocked: false })).toBe(false);
    expect(reductionAnalyticsProperties()).toEqual({});
    expect(reductionDiscountSupported()).toBe(false);
    expect(reductionTaxIsCalculated()).toBe(true);
    expect(reductionContinueDestination("22222222-2222-4222-8222-222222222222")).toContain("/jobs/");
    expect(presentChangeEditor({ authStatus: "access_expired", loading: false, draft }).draft).toBeUndefined();
  });

  it("rebases an overlapping reduction save onto the version that save advanced", async () => {
    const server = { version: 1, stored: "" };
    let current = "partial";
    let keys = 0;
    const result = await saveExtraWorkUntilQuiet({
      version: 1,
      savedFingerprint: "",
      readFingerprint: () => current,
      createKey: () => `reduction-${(keys += 1)}`,
      send: async (request) => {
        if (request.fingerprint === "partial") {
          current = "source:5000";
        }
        if (request.ifMatch !== server.version) {
          return { ok: false, status: 409, code: "VERSION_CONFLICT" };
        }
        server.version += 1;
        server.stored = request.fingerprint;
        return { ok: true, version: server.version };
      },
    });
    expect(result.conflict).toBeUndefined();
    expect(result.requests.map((request) => request.ifMatch)).toEqual([1, 2]);
    expect(server).toEqual({ version: 3, stored: "source:5000" });
  });
});

describe("change preview and publish", () => {
  const preview = {
    draft_id: "11111111-1111-4111-8111-111111111111",
    version: 2,
    preview_hash: "a".repeat(64),
    snapshot: {
      kind: "change" as const,
      business: { business_name: "Fixture Co" },
      customer: { name: "Fixture Customer", email: "fixture@example.com" },
      reason: "Extra socket",
      previous_total_cents: 22000,
      change_including_tax_cents: 10000,
      new_agreed_total_cents: 32000,
      additions: [{ description: "Hello", quantity: "1.000", unit: "item", total_cents: 10000 }],
      reductions: [],
    },
  };

  it("opens a customer preview without publishing and ignores a second tap", () => {
    const inFlight = { current: false };
    const first = beginChangePreviewRequest({
      draftId: preview.draft_id,
      version: preview.version,
      allowed: true,
      inFlight,
    });
    const second = beginChangePreviewRequest({
      draftId: preview.draft_id,
      version: preview.version,
      allowed: true,
      inFlight,
    });
    expect(changePreviewPublishes()).toBe(false);
    expect(first).toEqual({
      kind: "request",
      path: `/v1/drafts/${preview.draft_id}/preview`,
      method: "POST",
      ifMatch: 2,
    });
    expect(second).toEqual({ kind: "ignored" });
    expect(JSON.stringify(first)).not.toContain("/publish");
  });

  it("shows the unpublished customer preview with the revised total", () => {
    const view = presentChangeCustomerPreview(preview.snapshot);
    expect(view.unpublishedLabel).toBe("Preview • Not published");
    expect(view.previousCents).toBe(22000);
    expect(view.changeCents).toBe(10000);
    expect(view.revisedCents).toBe(32000);
    expect(view.additions[0]).toMatchObject({ description: "Hello", amountCents: 10000 });
    expect(view.customerName).toBe("Fixture Customer");
  });

  it("publishes only after explicit confirmation and keeps one in-flight request", () => {
    const inFlight = { current: false };
    expect(beginChangePublishRequest({ confirming: false, preview, inFlight }).kind).toBe("ignored");
    const first = beginChangePublishRequest({ confirming: true, preview, inFlight });
    const second = beginChangePublishRequest({ confirming: true, preview, inFlight });
    expect(first.kind).toBe("request");
    if (first.kind !== "request") {
      throw new Error("expected a publish request");
    }
    expect(first.path).toBe(`/v1/drafts/${preview.draft_id}/publish`);
    expect(first.ifMatch).toBe(2);
    expect(first.body.preview_hash).toBe(preview.preview_hash);
    expect(first.body.recipient_email).toBe("fixture@example.com");
    expect(second).toEqual({ kind: "ignored" });
  });

  it("keeps a failed publish visible and asks for a new preview when the hash is stale", () => {
    const pending = presentChangeOperation({
      message: "This job already has a pending approval request.",
      retryable: false,
      status: 409,
      code: "APPROVAL_PENDING",
    });
    expect(pending?.visible).toBe(true);
    expect(pending?.message).toBe("This job already has a pending approval request.");
    expect(pending?.showRetry).toBe(false);
    const stale = presentChangeOperation({
      message: "Regenerate the preview.",
      retryable: true,
      status: 409,
      code: "PREVIEW_CHANGED",
    });
    expect(stale?.showRetry).toBe(true);
    expect(stale?.retryLabel).toBe("Open preview again");
    expect(changePreviewAfterFailure(preview, "PREVIEW_CHANGED")?.preview_hash).toBe("");
    expect(beginChangePublishRequest({ confirming: true, preview: changePreviewAfterFailure(preview, "PREVIEW_CHANGED"), inFlight: { current: false } }).kind).toBe(
      "stale_preview",
    );
  });

  it("requires a fresh preview after the recipient changes and does not publish from preview", () => {
    const first = changeRecipientPlan({ previewEmail: null, enteredEmail: "" });
    const second = changeRecipientPlan({ previewEmail: "owner@example.com", enteredEmail: "owner@example.com" });
    const updated = changeRecipientPlan({ previewEmail: null, enteredEmail: "next@example.com" });
    const otherWorkspace = changeRecipientPlan({ previewEmail: "a@example.com", enteredEmail: "b@example.com" });
    expect(first.kind).toBe("missing");
    expect(presentChangeRecipient(first)?.message).toContain("no email");
    expect(presentChangeRecipient(first)?.recovery).toBe("none");
    expect(second).toEqual({ kind: "ready", email: "owner@example.com" });
    expect(updated).toEqual({ kind: "needs_preview", email: "next@example.com" });
    expect(otherWorkspace.kind).toBe("needs_preview");
    const patch = changeCustomerEmailPatch("next@example.com");
    expect(patch.ok).toBe(true);
    if (patch.ok) {
      expect(patch.value.email).toBe("next@example.com");
    }
    const previewRequest = beginChangePreviewRequest({
      draftId: preview.draft_id,
      version: 4,
      allowed: true,
      inFlight: { current: false },
    });
    expect(previewRequest.kind).toBe("request");
    if (previewRequest.kind === "request") {
      expect(previewRequest.path.endsWith("/preview")).toBe(true);
      expect(previewRequest.path.includes("/publish")).toBe(false);
    }
    const blockedSend = beginChangePublishRequest({
      confirming: true,
      preview: { ...preview, snapshot: { customer: { email: null } } },
      inFlight: { current: false },
    });
    expect(blockedSend.kind).toBe("missing_recipient");
  });

  it("explains a missing customer email and does not offer another send", () => {
    const blocked = beginChangePublishRequest({
      confirming: true,
      preview: { ...preview, snapshot: { customer: { email: null } } },
      inFlight: { current: false },
    });
    expect(blocked.kind).toBe("missing_recipient");
    const notice = presentBlockedChangePublish("missing_recipient");
    expect(notice.message).toBe("This customer has no email address. Add an email before sending this change.");
    expect(notice.showRetry).toBe(false);
    expect(notice.recovery).toBe("none");
    expect(changePublishFollowUp(notice.recovery)).toEqual({ action: "none" });
  });

  it("checks an uncertain publish response instead of sending again", () => {
    const dropped = presentChangePublishResponse({
      ok: false,
      status: 0,
      code: "UNAVAILABLE",
      message: "Could not reach the network. Try again.",
      retryable: true,
    });
    const unreadable = presentChangePublishResponse({ ok: true, status: 202 });
    expect(dropped.recovery).toBe("check_draft");
    expect(dropped.showRetry).toBe(false);
    expect(dropped.message).toBe("The result of sending this change is unknown. Check the job before sending again.");
    expect(unreadable.recovery).toBe("check_draft");
    expect(changePublishFollowUp(dropped.recovery)).toEqual({ action: "check_draft" });
    expect(changePublishFollowUp(unreadable.recovery).action).not.toBe("publish_same_key");
  });
});
