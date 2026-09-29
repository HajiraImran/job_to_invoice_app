import { calculateChangeOrder } from "@job-to-invoice/domain";
import {
  dollarsStringToCents,
  formatUsdCents,
  LINE_UNITS,
  parseChangeDraft,
  parseCustomerPatch,
  parseOwnerEmail,
  parseQuotePublish,
  type LineUnit,
} from "@job-to-invoice/schemas";
import { copy } from "../i18n/en.ts";
import { jobDetailPath } from "../jobs/routes.ts";
import { retainOrCreateSetupIdempotencyKey } from "../setup/idempotency.ts";

export type ChangeSource = {
  source_line_id: string;
  description: string;
  original_net_cents?: number;
  original_tax_cents?: number;
  remaining_net_cents: number;
  remaining_tax_cents: number;
};

export type ChangeDraftRecord = {
  id: string;
  job_id: string;
  kind: string;
  draft_state: string;
  version: number;
  reason: string;
  expected_scope_version: number;
  expiry_days: number;
  additions: Array<{
    client_line_id: string;
    description: string;
    unit: string;
    custom_unit_label: string | null;
    quantity: string;
    unit_price_cents: number;
    discount_cents: number;
    tax_bp: number;
  }>;
  reductions: Array<{ source_line_id: string; net_credit_cents: number }>;
  sources: ChangeSource[];
  previous_total_cents: number;
  change_including_tax_cents: number;
  new_agreed_total_cents: number;
  default_tax_bp: number;
  updated_at?: string;
};

export type ChangeEditorSession =
  | { kind: "start" }
  | { kind: "resume" }
  | {
      kind: "published";
      changeId: string;
      lifecycle: string;
      request_state: string | null;
    };

export function resolveChangeEditorSession(input: {
  intent: "extra" | "reduce";
  latestChange?: {
    id: string;
    lifecycle: string;
    request_state: string | null;
  } | null;
  changeDraft?: { id: string; additionsCount: number; reductionsCount: number } | null;
}): ChangeEditorSession {
  const published = input.latestChange;
  const pending = Boolean(
    published && (published.lifecycle === "issued" || published.request_state === "pending"),
  );
  if (pending && published) {
    return {
      kind: "published",
      changeId: published.id,
      lifecycle: published.lifecycle,
      request_state: published.request_state,
    };
  }
  const additions = input.changeDraft?.additionsCount ?? 0;
  const reductions = input.changeDraft?.reductionsCount ?? 0;
  const hasWork = additions + reductions > 0;
  if (hasWork) {
    return { kind: "resume" };
  }
  const approved = Boolean(
    published && (published.lifecycle === "accepted" || published.request_state === "approved"),
  );
  if (input.intent === "extra" && approved && published) {
    return {
      kind: "published",
      changeId: published.id,
      lifecycle: published.lifecycle,
      request_state: published.request_state,
    };
  }
  if (input.changeDraft) {
    return { kind: "resume" };
  }
  return { kind: "start" };
}

export function extraWorkLoadPlan(
  session: ChangeEditorSession,
  jobId: string,
): Array<{ method: "GET" | "POST"; path: string }> {
  const job = { method: "GET" as const, path: `/v1/jobs/${jobId}` };
  if (session.kind === "published") {
    return [
      job,
      { method: "GET", path: `/v1/documents/${session.changeId}` },
      { method: "GET", path: `/v1/documents/${session.changeId}/download` },
    ];
  }
  return [job, { method: "POST", path: `/v1/jobs/${jobId}/changes` }];
}

export function extraWorkEmailSavePlan(
  customerId: string,
  draftId: string,
): Array<{ method: "GET" | "PATCH" | "POST"; path: string }> {
  return [
    { method: "GET", path: `/v1/customers/${customerId}` },
    { method: "PATCH", path: `/v1/customers/${customerId}` },
    { method: "POST", path: `/v1/drafts/${draftId}/preview` },
  ];
}

export function extraWorkEmailSavePublishes(): false {
  return false;
}

export function extraWorkReturnAfterSendPlan(jobId: string): Array<{ method: "GET"; path: string }> {
  return [{ method: "GET", path: `/v1/jobs/${jobId}` }];
}

export function extraWorkPdfAccessPlan(changeId: string): Array<{ method: "GET"; path: string }> {
  return [{ method: "GET", path: `/v1/documents/${changeId}/download` }];
}

export function reductionLoadPlan(
  session: ChangeEditorSession,
  jobId: string,
): Array<{ method: "GET" | "POST"; path: string }> {
  const job = { method: "GET" as const, path: `/v1/jobs/${jobId}` };
  if (session.kind === "published") {
    return [job];
  }
  return [job, { method: "POST", path: `/v1/jobs/${jobId}/changes` }];
}

export function presentExtraWorkPublished(input: {
  number: string;
  revision_no: number;
  lifecycle: string;
  request_state: string | null;
  additions?: Array<{ description: string; total_cents: number }>;
}): {
  title: string;
  status: string;
  canStartAnother: boolean;
  lines: Array<{ description: string; amount: string }>;
} {
  const approved = input.lifecycle === "accepted" || input.request_state === "approved";
  return {
    title: `${input.number} R${input.revision_no}`,
    status: changeStatusLabel(input.lifecycle, input.request_state),
    canStartAnother: approved,
    lines: (input.additions ?? []).map((line) => ({
      description: line.description,
      amount: formatUsdCents(line.total_cents),
    })),
  };
}

export type ChangeEditorKind = "loading" | "loaded" | "empty" | "error" | "offline" | "blocked" | "access_expired";

export function presentChangeEditor(input: {
  authStatus: string;
  loading: boolean;
  draft?: ChangeDraftRecord;
  error?: { message: string; retryable: boolean; status: number; code?: string };
}): { kind: ChangeEditorKind; showRetry: boolean; message?: string; draft?: ChangeDraftRecord } {
  if (input.authStatus === "access_expired") {
    return { kind: "access_expired", showRetry: false, message: copy.accessExpired };
  }
  if (input.authStatus === "offline_cached") {
    return { kind: "offline", showRetry: true, message: copy.changeOffline, draft: input.draft };
  }
  if (input.loading && !input.draft) {
    return { kind: "loading", showRetry: false };
  }
  if (input.error && !input.draft) {
    if (input.error.code === "VALIDATION_FAILED" || input.error.status === 422) {
      return { kind: "blocked", showRetry: false, message: input.error.message || copy.changeBlocked };
    }
    return {
      kind: "error",
      showRetry: input.error.retryable || input.error.status === 0,
      message: input.error.message || copy.changeLoadError,
    };
  }
  if (!input.draft) {
    return { kind: "error", showRetry: true, message: copy.changeLoadError };
  }
  if (input.draft.additions.length + input.draft.reductions.length === 0) {
    return { kind: "empty", showRetry: false, draft: input.draft, message: copy.changeEmpty };
  }
  return { kind: "loaded", showRetry: false, draft: input.draft };
}

export type ExtraWorkLineForm = {
  client_line_id: string;
  description: string;
  quantity: string;
  unit: string;
  unit_price: string;
  tax_percent: string;
};

export type ExtraWorkSaveState = "idle" | "saving" | "saved" | "failed" | "offline" | "invalid";

export function extraWorkSaveLabel(state: ExtraWorkSaveState): string {
  if (state === "saving") return copy.extraWorkSaving;
  if (state === "saved") return copy.extraWorkSaved;
  if (state === "offline") return copy.extraWorkOfflineStatus;
  if (state === "failed") return copy.extraWorkSaveFailed;
  if (state === "invalid") return copy.extraWorkNotSaved;
  return copy.extraWorkDraft;
}

export function extraWorkTaxBp(percent: string): { ok: true; value: number } | { ok: false } {
  const trimmed = percent.trim().replace(/%$/, "");
  if (!/^(0|[1-9]\d?)(\.\d{1,2})?$/.test(trimmed)) {
    return { ok: false };
  }
  const [wholeRaw, fracRaw = ""] = trimmed.split(".");
  const whole = Number(wholeRaw);
  const frac = Number((fracRaw + "00").slice(0, 2));
  const basisPoints = whole * 100 + frac;
  if (!Number.isInteger(basisPoints) || basisPoints > 10000) {
    return { ok: false };
  }
  return { ok: true, value: basisPoints };
}

export function extraWorkPayload(input: {
  reason: string;
  expectedScopeVersion: number;
  expiryDays: number;
  lines: ExtraWorkLineForm[];
}) {
  return {
    reason: input.reason,
    expected_scope_version: input.expectedScopeVersion,
    expiry_days: input.expiryDays,
    additions: input.lines.map((line) => {
      const price = dollarsStringToCents(line.unit_price);
      const tax = extraWorkTaxBp(line.tax_percent);
      return {
        client_line_id: line.client_line_id,
        description: line.description,
        unit: line.unit,
        custom_unit_label: null,
        quantity: line.quantity,
        unit_price_cents: price.ok ? price.value : line.unit_price,
        discount_cents: 0,
        tax_bp: tax.ok ? tax.value : line.tax_percent,
      };
    }),
    reductions: [] as Array<{ source_line_id: string; net_credit_cents: number }>,
  };
}

export function extraWorkFieldErrors(input: {
  reason: string;
  expectedScopeVersion: number;
  expiryDays: number;
  lines: ExtraWorkLineForm[];
}): { field: string; message: string }[] {
  if (input.lines.length === 0) {
    return [{ field: "additions", message: copy.extraWorkEmpty }];
  }
  const parsed = parseChangeDraft(
    extraWorkPayload({
      reason: input.reason,
      expectedScopeVersion: input.expectedScopeVersion,
      expiryDays: input.expiryDays,
      lines: input.lines,
    }),
  );
  if (!parsed.ok) {
    return parsed.field_errors;
  }
  const priced = parsed.value.additions.flatMap((line, index) =>
    line.unit_price_cents < 1
      ? [{ field: `additions.${index}.unit_price_cents`, message: "Price must be greater than $0." }]
      : [],
  );
  return priced;
}

export function extraWorkReviewBlocked(input: {
  offline: boolean;
  busy: boolean;
  accessExpired: boolean;
  lineCount: number;
  fieldErrorCount: number;
}): boolean {
  return input.offline || input.busy || input.accessExpired || input.lineCount < 1 || input.fieldErrorCount > 0;
}

export function extraWorkTotals(previousCents: number, lines: ExtraWorkLineForm[]): {
  acceptedCents: number;
  extraCents: number;
  revisedCents: number;
} | undefined {
  if (!Number.isInteger(previousCents) || previousCents < 0) {
    return undefined;
  }
  if (lines.length === 0) {
    return { acceptedCents: previousCents, extraCents: 0, revisedCents: previousCents };
  }
  const errors = extraWorkFieldErrors({
    reason: "Valid reason",
    expectedScopeVersion: 1,
    expiryDays: 14,
    lines,
  }).filter((error) => error.field !== "reason");
  if (errors.length > 0) {
    return { acceptedCents: previousCents, extraCents: 0, revisedCents: previousCents };
  }
  const payload = extraWorkPayload({
    reason: "Valid reason",
    expectedScopeVersion: 1,
    expiryDays: 14,
    lines,
  });
  const parsed = parseChangeDraft(payload);
  if (!parsed.ok) {
    return undefined;
  }
  try {
    const calculated = calculateChangeOrder({
      previous_total_cents: previousCents,
      additions: parsed.value.additions,
      reductions: [],
      sources: [],
    });
    return {
      acceptedCents: calculated.previous_total_cents,
      extraCents: calculated.addition_total_cents,
      revisedCents: calculated.new_agreed_total_cents,
    };
  } catch {
    return undefined;
  }
}

export function extraWorkLineMeta(line: ExtraWorkLineForm): string {
  const price = dollarsStringToCents(line.unit_price);
  const amount = price.ok ? formatUsdCents(price.value) : line.unit_price;
  const unit = (LINE_UNITS as readonly string[]).includes(line.unit) ? line.unit.replaceAll("_", " ") : line.unit;
  return `${line.quantity} ${unit} × ${amount}`;
}

export function extraWorkLineTotalCents(line: ExtraWorkLineForm): number | undefined {
  const totals = extraWorkTotals(0, [line]);
  return totals?.extraCents;
}

export function extraWorkIdempotencyAfterFailure(current: string | undefined, code?: string): string | undefined {
  if (code === "IDEMPOTENCY_MISMATCH") {
    return undefined;
  }
  return current;
}

export function extraWorkResponseIsCurrent(startedGeneration: number, latestGeneration: number): boolean {
  return startedGeneration === latestGeneration;
}

export type ExtraWorkTransportResult =
  | { ok: true; version: number }
  | { ok: false; status: number; code: string };

export type ExtraWorkSaveRequest = {
  ifMatch: number;
  idempotencyKey: string;
  fingerprint: string;
};

export function createExtraWorkSaveGate(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export async function saveExtraWorkUntilQuiet(input: {
  version: number;
  savedFingerprint: string;
  readFingerprint: () => string;
  createKey: () => string;
  initialKey?: string;
  initialKeyFingerprint?: string;
  send: (request: ExtraWorkSaveRequest) => Promise<ExtraWorkTransportResult>;
  maxPasses?: number;
}): Promise<{
  version: number;
  savedFingerprint: string;
  idempotencyKey?: string;
  keyFingerprint?: string;
  conflict?: { status: number; code: string };
  failure?: { status: number; code: string };
  invalid: boolean;
  requests: ExtraWorkSaveRequest[];
}> {
  let version = input.version;
  let savedFingerprint = input.savedFingerprint;
  let idempotencyKey = input.initialKey;
  let keyFingerprint = input.initialKeyFingerprint;
  const requests: ExtraWorkSaveRequest[] = [];
  const maxPasses = input.maxPasses ?? 8;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const fingerprint = input.readFingerprint();
    if (fingerprint === savedFingerprint) {
      return { version, savedFingerprint, idempotencyKey, keyFingerprint, invalid: false, requests };
    }
    if (keyFingerprint !== fingerprint) {
      idempotencyKey = undefined;
    }
    idempotencyKey = idempotencyKey ?? input.createKey();
    keyFingerprint = fingerprint;
    const request = { ifMatch: version, idempotencyKey, fingerprint };
    const result = await input.send(request);
    requests.push(request);
    if (!result.ok) {
      if (result.code === "LOCAL_INVALID") {
        return { version, savedFingerprint, idempotencyKey, keyFingerprint, invalid: true, requests };
      }
      if (result.code === "IDEMPOTENCY_MISMATCH") {
        idempotencyKey = undefined;
        keyFingerprint = undefined;
      }
      const failure = { status: result.status, code: result.code };
      if (result.code === "VERSION_CONFLICT" || result.code === "PREVIEW_CHANGED") {
        return {
          version,
          savedFingerprint,
          idempotencyKey,
          keyFingerprint,
          conflict: failure,
          failure,
          invalid: false,
          requests,
        };
      }
      return { version, savedFingerprint, idempotencyKey, keyFingerprint, failure, invalid: false, requests };
    }
    version = result.version;
    savedFingerprint = fingerprint;
    if (input.readFingerprint() !== fingerprint) {
      idempotencyKey = undefined;
      keyFingerprint = undefined;
    }
  }
  return { version, savedFingerprint, idempotencyKey, keyFingerprint, invalid: false, requests };
}

export function extraWorkContinueDestination(jobId: string): string {
  return jobDetailPath(jobId);
}

export function extraWorkPreviewAllowed(input: { offline: boolean; accessExpired: boolean; reviewBlocked: boolean }): boolean {
  return !input.offline && !input.accessExpired && !input.reviewBlocked;
}

export type ChangePreviewSnapshot = {
  kind: "change";
  business: { business_name: string };
  customer: { name: string; email?: string | null };
  reason: string;
  previous_total_cents: number;
  change_including_tax_cents: number;
  new_agreed_total_cents: number;
  additions: Array<{
    description: string;
    quantity: string;
    unit: string;
    custom_unit_label?: string | null;
    total_cents: number;
  }>;
  reductions: Array<{ description: string; total_reduction_cents: number }>;
};

export type ChangePreviewRecord = {
  draft_id: string;
  job_id: string;
  version: number;
  preview_hash: string;
  preview_expires_at: string;
  snapshot: ChangePreviewSnapshot;
};

export type ChangeOperationError = {
  message: string;
  retryable: boolean;
  status: number;
  code?: string;
};

export function changePreviewPublishes(): false {
  return false;
}

export function beginChangePreviewRequest(input: {
  draftId: string;
  version: number;
  allowed: boolean;
  inFlight: { current: boolean };
}): { kind: "ignored" } | { kind: "request"; path: string; method: "POST"; ifMatch: number } {
  if (!input.allowed || input.inFlight.current || input.draftId.length === 0) {
    return { kind: "ignored" };
  }
  input.inFlight.current = true;
  return {
    kind: "request",
    path: `/v1/drafts/${input.draftId}/preview`,
    method: "POST",
    ifMatch: input.version,
  };
}

export function presentChangeCustomerPreview(snapshot: ChangePreviewSnapshot): {
  unpublishedLabel: string;
  businessName: string;
  customerName: string;
  reason: string;
  previousCents: number;
  changeCents: number;
  revisedCents: number;
  additions: Array<{ description: string; quantity: string; unit: string; amountCents: number }>;
  reductions: Array<{ description: string; amountCents: number }>;
} {
  return {
    unpublishedLabel: copy.previewNotPublished,
    businessName: snapshot.business.business_name,
    customerName: snapshot.customer.name,
    reason: snapshot.reason,
    previousCents: snapshot.previous_total_cents,
    changeCents: snapshot.change_including_tax_cents,
    revisedCents: snapshot.new_agreed_total_cents,
    additions: snapshot.additions.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unit: line.custom_unit_label ?? line.unit,
      amountCents: line.total_cents,
    })),
    reductions: snapshot.reductions.map((line) => ({
      description: line.description,
      amountCents: line.total_reduction_cents,
    })),
  };
}

export function beginChangePublishRequest(input: {
  confirming: boolean;
  preview?: {
    draft_id: string;
    version: number;
    preview_hash: string;
    snapshot: { customer?: { email?: string | null } };
  };
  inFlight: { current: boolean };
  idempotencyKey?: string;
}):
  | { kind: "ignored" }
  | { kind: "missing_recipient" }
  | { kind: "stale_preview" }
  | {
      kind: "request";
      idempotencyKey: string;
      path: string;
      method: "POST";
      ifMatch: number;
      body: { preview_hash: string; recipient_email: string };
    } {
  if (!input.confirming || !input.preview || input.inFlight.current) {
    return { kind: "ignored" };
  }
  const parsed = parseQuotePublish({
    preview_hash: input.preview.preview_hash,
    recipient_email: input.preview.snapshot.customer?.email ?? "",
  });
  if (!parsed.ok) {
    const stale = parsed.field_errors.some((error) => error.field === "preview_hash");
    return { kind: stale ? "stale_preview" : "missing_recipient" };
  }
  input.inFlight.current = true;
  const idempotencyKey = input.idempotencyKey ?? retainOrCreateSetupIdempotencyKey(undefined);
  return {
    kind: "request",
    idempotencyKey,
    path: `/v1/drafts/${input.preview.draft_id}/publish`,
    method: "POST",
    ifMatch: input.preview.version,
    body: {
      preview_hash: parsed.value.preview_hash,
      recipient_email: parsed.value.recipient_email,
    },
  };
}

export function changePreviewAfterFailure<T extends { preview_hash: string }>(
  preview: T | undefined,
  code: string | undefined,
): T | undefined {
  if (!preview) {
    return preview;
  }
  if (code === "PREVIEW_CHANGED" || code === "VERSION_CONFLICT") {
    return { ...preview, preview_hash: "" };
  }
  return preview;
}

export type ChangePublishRecovery = "none" | "refresh_preview" | "check_draft" | "publish_same_key";

export type ChangePublishNotice = {
  message: string;
  showRetry: boolean;
  retryLabel: string;
  showCheck: boolean;
  checkLabel: string;
  recovery: ChangePublishRecovery;
};

export function presentChangePreviewFailure(error: ChangeOperationError): ChangePublishNotice {
  const refresh = error.code === "PREVIEW_CHANGED" || error.code === "VERSION_CONFLICT";
  return {
    message: error.message || copy.changeLoadError,
    showRetry: refresh || error.retryable || error.status === 0,
    retryLabel: refresh ? copy.changePreviewRefresh : copy.retry,
    showCheck: false,
    checkLabel: copy.changePublishCheck,
    recovery: "refresh_preview",
  };
}

export type ChangeRecipientPlan =
  | { kind: "ready"; email: string }
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "needs_preview"; email: string };

function normalizedRecipient(value: string | null | undefined): string | undefined {
  const parsed = parseOwnerEmail(value ?? "");
  return parsed.ok ? parsed.normalized : undefined;
}

export function changeRecipientPlan(input: { previewEmail?: string | null; enteredEmail: string }): ChangeRecipientPlan {
  const entered = input.enteredEmail.trim();
  const frozen = (input.previewEmail ?? "").trim();
  const enteredNormal = normalizedRecipient(entered);
  const frozenNormal = normalizedRecipient(frozen);
  if (entered && !enteredNormal) {
    return { kind: "invalid" };
  }
  if (enteredNormal && enteredNormal === frozenNormal) {
    return { kind: "ready", email: frozen };
  }
  if (enteredNormal) {
    const parsed = parseOwnerEmail(entered);
    if (parsed.ok) {
      return { kind: "needs_preview", email: parsed.display };
    }
  }
  return { kind: "missing" };
}

export function changeCustomerEmailPatch(email: string) {
  return parseCustomerPatch({ email });
}

export function presentChangeRecipient(plan: ChangeRecipientPlan): ChangePublishNotice | undefined {
  if (plan.kind === "ready") {
    return undefined;
  }
  const message =
    plan.kind === "invalid"
      ? copy.changeRecipientInvalid
      : plan.kind === "needs_preview"
        ? copy.changeRecipientStale
        : copy.changeMissingRecipient;
  return {
    message,
    showRetry: false,
    retryLabel: copy.retry,
    showCheck: false,
    checkLabel: copy.changePublishCheck,
    recovery: "none",
  };
}

export function presentBlockedChangePublish(kind: "missing_recipient" | "stale_preview"): ChangePublishNotice {
  if (kind === "stale_preview") {
    return {
      message: copy.changePreviewRefresh,
      showRetry: true,
      retryLabel: copy.changePreviewRefresh,
      showCheck: false,
      checkLabel: copy.changePublishCheck,
      recovery: "refresh_preview",
    };
  }
  return {
    message: copy.changeMissingRecipient,
    showRetry: false,
    retryLabel: copy.retry,
    showCheck: false,
    checkLabel: copy.changePublishCheck,
    recovery: "none",
  };
}

export function presentChangePublishResponse(input: {
  ok: boolean;
  status: number;
  code?: string;
  message?: string;
  retryable?: boolean;
  publishedId?: string;
}): ChangePublishNotice {
  const published = input.ok && typeof input.publishedId === "string" && input.publishedId.length > 0;
  if (!published && (input.ok || input.status === 0 || input.status >= 500)) {
    return {
      message: copy.changePublishUncertain,
      showRetry: false,
      retryLabel: copy.changePublishCheck,
      showCheck: true,
      checkLabel: copy.changePublishCheck,
      recovery: "check_draft",
    };
  }
  const refresh = input.code === "PREVIEW_CHANGED" || input.code === "VERSION_CONFLICT";
  const retrySameKey = input.retryable === true && !refresh;
  return {
    message: input.message?.trim() || copy.changePublishRejected,
    showRetry: refresh || retrySameKey,
    retryLabel: refresh ? copy.changePreviewRefresh : copy.retry,
    showCheck: false,
    checkLabel: copy.changePublishCheck,
    recovery: refresh ? "refresh_preview" : retrySameKey ? "publish_same_key" : "none",
  };
}

export function changePublishFollowUp(recovery: ChangePublishRecovery):
  | { action: "none" }
  | { action: "refresh_preview" }
  | { action: "check_draft" }
  | { action: "publish_same_key" } {
  if (recovery === "none") {
    return { action: "none" };
  }
  return { action: recovery };
}

export function presentChangeOperation(error?: ChangeOperationError):
  | { visible: true; message: string; showRetry: boolean; retryLabel: string }
  | undefined {
  if (!error) {
    return undefined;
  }
  const refresh = error.code === "PREVIEW_CHANGED" || error.code === "VERSION_CONFLICT";
  return {
    visible: true,
    message: error.message || copy.changeLoadError,
    showRetry: refresh || error.retryable || error.status === 0,
    retryLabel: refresh ? copy.changePreviewRefresh : copy.retry,
  };
}

export function extraWorkAnalyticsProperties(): Record<string, never> {
  return {};
}

export function extraWorkDiscountSupported(): false {
  return false;
}

export function isExtraWorkUnit(value: string): value is LineUnit {
  return (LINE_UNITS as readonly string[]).includes(value);
}

export type ReductionAmountForm = { source_line_id: string; amount: string };

export function reductionDraftIsCompatible(draft: { kind: string; additions: readonly unknown[] }): boolean {
  return draft.kind === "change" && draft.additions.length === 0;
}

export function reductionSourceModel(source: ChangeSource) {
  const originalNet = source.original_net_cents ?? source.remaining_net_cents;
  const originalTax = source.original_tax_cents ?? source.remaining_tax_cents;
  const prior = originalNet - source.remaining_net_cents;
  return {
    source_line_id: source.source_line_id,
    original_net_cents: originalNet,
    original_tax_cents: originalTax,
    accepted_net_reductions_cents: prior > 0 ? prior : 0,
  };
}

export function formatDeductionCents(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new Error("USD amounts must be integer cents; JavaScript floats are forbidden");
  }
  const abs = cents < 0 ? -cents : cents;
  return `−${formatUsdCents(abs)}`;
}

export function subtractReductionCents(acceptedCents: number, reductionCents: number): {
  acceptedCents: number;
  reductionCents: number;
  revisedCents: number;
  exceedsAccepted: boolean;
} | undefined {
  if (!Number.isInteger(acceptedCents) || !Number.isInteger(reductionCents) || acceptedCents < 0 || reductionCents < 0) {
    return undefined;
  }
  return {
    acceptedCents,
    reductionCents,
    revisedCents: acceptedCents - reductionCents,
    exceedsAccepted: reductionCents > acceptedCents,
  };
}

export function reductionPayload(input: {
  reason: string;
  expectedScopeVersion: number;
  expiryDays: number;
  amounts: ReductionAmountForm[];
}) {
  const reductions = input.amounts.flatMap((line) => {
    const parsed = dollarsStringToCents(line.amount);
    return parsed.ok && parsed.value > 0 ? [{ source_line_id: line.source_line_id, net_credit_cents: parsed.value }] : [];
  });
  return {
    reason: input.reason,
    expected_scope_version: input.expectedScopeVersion,
    expiry_days: input.expiryDays,
    additions: [] as [],
    reductions,
  };
}

export function reductionFieldErrors(input: {
  reason: string;
  expectedScopeVersion: number;
  expiryDays: number;
  sources: ChangeSource[];
  amounts: ReductionAmountForm[];
}): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  if (!reductionDraftIsCompatible({ kind: "change", additions: [] }) || input.amounts.length === 0) {
    if (input.amounts.length === 0) {
      errors.push({ field: "reductions", message: copy.reductionEmpty });
    }
  }
  const byId = new Map(input.sources.map((source) => [source.source_line_id, source]));
  for (const [index, line] of input.amounts.entries()) {
    const source = byId.get(line.source_line_id);
    if (!source) {
      errors.push({ field: `reductions.${index}.source_line_id`, message: "Choose an approved source line." });
      continue;
    }
    const parsed = dollarsStringToCents(line.amount);
    if (!parsed.ok || parsed.value < 1) {
      errors.push({ field: `reductions.${index}.net_credit_cents`, message: "Enter a reduction greater than $0." });
      continue;
    }
    if (parsed.value > source.remaining_net_cents) {
      errors.push({
        field: `reductions.${index}.net_credit_cents`,
        message: "This reduction exceeds the remaining amount on this line.",
      });
    }
  }
  const payload = reductionPayload(input);
  if (payload.reductions.length > 0) {
    const parsed = parseChangeDraft(payload);
    if (!parsed.ok) {
      errors.push(...parsed.field_errors.filter((error) => error.field === "reason" || error.field.startsWith("reductions")));
    } else {
      try {
        calculateChangeOrder({
          previous_total_cents: input.sources.reduce(
            (sum, source) => sum + source.remaining_net_cents + source.remaining_tax_cents,
            0,
          ),
          additions: [],
          reductions: parsed.value.reductions,
          sources: input.sources.map(reductionSourceModel),
          reason: parsed.value.reason,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Reduction is not valid.";
        errors.push({ field: "reductions", message });
      }
    }
  }
  return errors;
}

export function reductionTotals(input: {
  previousCents: number;
  sources: ChangeSource[];
  amounts: ReductionAmountForm[];
}): { acceptedCents: number; reductionCents: number; revisedCents: number; exceedsAccepted: boolean } | undefined {
  if (!Number.isInteger(input.previousCents) || input.previousCents < 0) {
    return undefined;
  }
  const payload = reductionPayload({
    reason: "Valid reason",
    expectedScopeVersion: 1,
    expiryDays: 14,
    amounts: input.amounts,
  });
  if (payload.reductions.length === 0) {
    return subtractReductionCents(input.previousCents, 0);
  }
  try {
    const calculated = calculateChangeOrder({
      previous_total_cents: input.previousCents,
      additions: [],
      reductions: payload.reductions,
      sources: input.sources.map(reductionSourceModel),
      reason: "Valid reason",
    });
    return {
      acceptedCents: calculated.previous_total_cents,
      reductionCents: calculated.reduction_total_cents,
      revisedCents: calculated.new_agreed_total_cents,
      exceedsAccepted: false,
    };
  } catch {
    const entered = payload.reductions.reduce((sum, line) => sum + line.net_credit_cents, 0);
    const display = subtractReductionCents(input.previousCents, entered);
    return display ? { ...display, exceedsAccepted: true } : undefined;
  }
}

export function reductionReviewBlocked(input: {
  offline: boolean;
  busy: boolean;
  accessExpired: boolean;
  incompatible: boolean;
  fieldErrorCount: number;
  lineCount: number;
}): boolean {
  return (
    input.offline ||
    input.busy ||
    input.accessExpired ||
    input.incompatible ||
    input.lineCount < 1 ||
    input.fieldErrorCount > 0
  );
}

export function reductionIdempotencyAfterFailure(current: string | undefined, code?: string): string | undefined {
  return extraWorkIdempotencyAfterFailure(current, code);
}

export function reductionResponseIsCurrent(startedGeneration: number, latestGeneration: number): boolean {
  return extraWorkResponseIsCurrent(startedGeneration, latestGeneration);
}

export function reductionContinueDestination(jobId: string): string {
  return jobDetailPath(jobId);
}

export function reductionPreviewAllowed(input: { offline: boolean; accessExpired: boolean; reviewBlocked: boolean }): boolean {
  return extraWorkPreviewAllowed(input);
}

export function reductionAnalyticsProperties(): Record<string, never> {
  return {};
}

export function reductionDiscountSupported(): false {
  return false;
}

export function reductionTaxIsCalculated(): true {
  return true;
}

export function changeStatusLabel(lifecycle: string, requestState?: string | null): string {
  if (requestState === "pending" || lifecycle === "issued") {
    return copy.changePending;
  }
  if (requestState === "approved" || lifecycle === "accepted") {
    return copy.changeApproved;
  }
  if (requestState === "declined" || lifecycle === "declined") {
    return copy.changeDeclined;
  }
  return lifecycle;
}
