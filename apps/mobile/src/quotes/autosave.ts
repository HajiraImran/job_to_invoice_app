import type { QuoteFormValues } from "./form.ts";
import type { QuoteSaveStatus } from "./presentation.ts";

export type QuotePersistStage =
  | "map_patch_body"
  | "read_existing"
  | "upsert_draft"
  | "enqueue_outbox"
  | "mark_queued"
  | "open_draft"
  | "hydrate";

export type QuoteAutosaveAction = "skip" | "schedule";

export function quoteFormFingerprint(values: QuoteFormValues): string {
  return JSON.stringify({
    notes: values.notes,
    terms: values.terms,
    expiry_days: values.expiry_days.trim(),
    lines: values.lines.map((line) => ({
      client_line_id: line.client_line_id,
      description: line.description,
      unit: line.unit,
      custom_unit_label: line.custom_unit_label,
      quantity: line.quantity,
      unit_price: line.unit_price,
      discount: line.discount,
      tax_percent: line.tax_percent,
    })),
  });
}

export function quoteFormIsUserEdited(currentFingerprint: string, lastSavedFingerprint: string | undefined): boolean {
  return lastSavedFingerprint !== undefined && currentFingerprint !== lastSavedFingerprint;
}

export function decideQuoteAutosave(input: {
  hasDraft: boolean;
  userEdited: boolean;
  saveStatus: QuoteSaveStatus;
  totalsOk: boolean;
  inFlight: boolean;
}): QuoteAutosaveAction {
  if (!input.hasDraft || !input.userEdited || !input.totalsOk || input.inFlight) {
    return "skip";
  }
  if (
    input.saveStatus === "conflict" ||
    input.saveStatus === "storage_failure" ||
    input.saveStatus === "error" ||
    input.saveStatus === "saving_locally" ||
    input.saveStatus === "synchronizing" ||
    input.saveStatus === "validation"
  ) {
    return "skip";
  }
  return "schedule";
}

export function persistResultIsCurrent(input: {
  startedGeneration: number;
  currentGeneration: number;
  draftJobId: string;
  screenJobId: string;
}): boolean {
  return input.startedGeneration === input.currentGeneration && input.draftJobId === input.screenJobId;
}

export function decideQuoteDraftOpen(input: {
  jobId: string;
  openedJobId: string | undefined;
  hasVisibleDraft: boolean;
  forceReload: boolean;
}): "skip" | "post_open" {
  if (!input.forceReload && input.openedJobId === input.jobId && input.hasVisibleDraft) {
    return "skip";
  }
  return "post_open";
}

const QUOTE_PERSIST_STAGES = new Set<string>([
  "map_patch_body",
  "read_existing",
  "upsert_draft",
  "enqueue_outbox",
  "mark_queued",
  "open_draft",
  "hydrate",
]);

export function emitQuotePersistDiagnostic(event: {
  stage: QuotePersistStage;
  outcome: "ok" | "storage_failure" | "skipped" | "stale";
  code?: string;
}): void {
  if (typeof __DEV__ === "undefined" || !__DEV__) {
    return;
  }
  const payload: { stage: QuotePersistStage; outcome: string; code?: string } = {
    stage: event.stage,
    outcome: event.outcome,
  };
  if (event.code) {
    payload.code = event.code;
  }
  console.info("[quote.persist]", JSON.stringify(payload));
}

const QUOTE_PERSIST_CODES = new Set<string>([
  "MAP_FAILED",
  "OUTBOX_FORBIDDEN",
  "UNSUPPORTED_RUNTIME",
  "INVALID_OWNER",
  "KEY_UNAVAILABLE",
  "DATABASE_UNAVAILABLE",
  "OWNER_MISMATCH",
  "OFFLINE_WINDOW_EXPIRED",
  "SYNC_PAUSED",
  "WIPE_FAILED",
]);

export function quotePersistDiagnosticIsSafe(
  event: Record<string, unknown>,
  forbiddenFragments: readonly string[],
): boolean {
  const allowed = new Set(["stage", "outcome", "code"]);
  for (const key of Object.keys(event)) {
    if (!allowed.has(key)) {
      return false;
    }
  }
  if (typeof event.stage !== "string" || !QUOTE_PERSIST_STAGES.has(event.stage)) {
    return false;
  }
  if (event.code !== undefined && (typeof event.code !== "string" || !QUOTE_PERSIST_CODES.has(event.code))) {
    return false;
  }
  const serialized = JSON.stringify(event);
  return !forbiddenFragments.some((fragment) => fragment.length > 0 && serialized.includes(fragment));
}
