export const WORKER_PDF_EVENT = "worker_pdf";

export const WORKER_PDF_STAGES = [
  "started",
  "claim_started",
  "no_work",
  "claimed",
  "source_loading",
  "rendering",
  "storage_put",
  "checksum",
  "complete_pdf",
  "fail_recording",
  "completed",
  "retry_scheduled",
  "dead",
  "database_connect_failed",
  "transaction_start_failed",
  "set_role_failed",
  "claim_query_failed",
  "connect_timed_out",
  "claim_timed_out",
] as const;

export type WorkerPdfStage = (typeof WORKER_PDF_STAGES)[number];

export const WORKER_PDF_SAFE_KEYS = ["event", "stage"] as const;
export const WORKER_PDF_OPTIONAL_KEYS = ["sqlstate", "category", "httpStatus", "attempt", "networkCode"] as const;

// Fixed tokens only. Error messages can carry hosts, keys, or signed URLs.
export const WORKER_NETWORK_CODES = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "TimeoutError",
  "AbortError",
  "AccessDenied",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "NoSuchBucket",
] as const;

export type WorkerNetworkCode = (typeof WORKER_NETWORK_CODES)[number];

const NETWORK_CODE_SET = new Set<string>(WORKER_NETWORK_CODES);

export function networkCodeOf(error: unknown): WorkerNetworkCode | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { code?: unknown; name?: unknown; Code?: unknown; errors?: unknown; cause?: unknown };
    for (const candidate of [record.code, record.Code, record.name]) {
      if (typeof candidate === "string" && NETWORK_CODE_SET.has(candidate)) {
        return candidate as WorkerNetworkCode;
      }
    }
    const nested = Array.isArray(record.errors) ? record.errors[0] : undefined;
    current = record.cause ?? nested;
  }
  return undefined;
}

export const WORKER_PDF_FAILURE_CATEGORIES = [
  "storage_rejected",
  "storage_unavailable",
  "database",
  "validation",
  "render",
  "unknown",
] as const;

export type WorkerPdfFailureCategory = (typeof WORKER_PDF_FAILURE_CATEGORIES)[number];

export type WorkerPdfSafeEvent = {
  event: typeof WORKER_PDF_EVENT;
  stage: WorkerPdfStage;
  sqlstate?: string;
  category?: WorkerPdfFailureCategory;
  httpStatus?: number;
  attempt?: number;
  networkCode?: WorkerNetworkCode;
};

const STAGE_SET = new Set<string>(WORKER_PDF_STAGES);
const KEY_SET = new Set<string>([...WORKER_PDF_SAFE_KEYS, ...WORKER_PDF_OPTIONAL_KEYS]);
const CATEGORY_SET = new Set<string>(WORKER_PDF_FAILURE_CATEGORIES);
const SQLSTATE_PATTERN = /^(08|0A|22|23|25|28|40|42|53|54|55|57|58|P0|XX)[0-9A-Z]{3}$/;

export function allowlistedSqlstate(value: unknown): string | undefined {
  if (typeof value !== "string" || !SQLSTATE_PATTERN.test(value)) {
    return undefined;
  }
  return value;
}

export function workerPdfSafeEvent(input: { stage: WorkerPdfStage; sqlstate?: string }): WorkerPdfSafeEvent {
  const event: WorkerPdfSafeEvent = {
    event: WORKER_PDF_EVENT,
    stage: input.stage,
  };
  const sqlstate = allowlistedSqlstate(input.sqlstate);
  if (sqlstate) {
    event.sqlstate = sqlstate;
  }
  return event;
}

export function workerPdfEventHasOnlySafeFields(value: unknown): value is WorkerPdfSafeEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !KEY_SET.has(key))) {
    return false;
  }
  if (!WORKER_PDF_SAFE_KEYS.every((key) => keys.includes(key))) {
    return false;
  }
  if (record.sqlstate !== undefined && allowlistedSqlstate(record.sqlstate) !== record.sqlstate) {
    return false;
  }
  if (record.category !== undefined && (typeof record.category !== "string" || !CATEGORY_SET.has(record.category))) {
    return false;
  }
  if (
    record.httpStatus !== undefined &&
    (typeof record.httpStatus !== "number" || !Number.isInteger(record.httpStatus) || record.httpStatus < 100 || record.httpStatus > 599)
  ) {
    return false;
  }
  if (
    record.attempt !== undefined &&
    (typeof record.attempt !== "number" || !Number.isInteger(record.attempt) || record.attempt < 0 || record.attempt > 20)
  ) {
    return false;
  }
  if (record.networkCode !== undefined && (typeof record.networkCode !== "string" || !NETWORK_CODE_SET.has(record.networkCode))) {
    return false;
  }
  return record.event === WORKER_PDF_EVENT && typeof record.stage === "string" && STAGE_SET.has(record.stage);
}

function httpStatusFromUnknown(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("$metadata" in error)) {
    return undefined;
  }
  const metadata = error.$metadata;
  if (!metadata || typeof metadata !== "object" || !("httpStatusCode" in metadata)) {
    return undefined;
  }
  const status = metadata.httpStatusCode;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
    return undefined;
  }
  return status;
}

function sqlstateOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  if ("sqlstate" in error && typeof error.sqlstate === "string") {
    return allowlistedSqlstate(error.sqlstate);
  }
  if ("code" in error && typeof error.code === "string") {
    return allowlistedSqlstate(error.code);
  }
  return undefined;
}

export function workerPdfFailureEvent(input: {
  stage: WorkerPdfStage;
  error: unknown;
  attempt?: number;
}): WorkerPdfSafeEvent {
  const event = workerPdfSafeEvent({ stage: input.stage, sqlstate: sqlstateOf(input.error) });
  const httpStatus = httpStatusFromUnknown(input.error);
  if (httpStatus !== undefined) {
    event.httpStatus = httpStatus;
    event.category = httpStatus >= 500 ? "storage_unavailable" : "storage_rejected";
  } else if (event.sqlstate) {
    event.category = "database";
  } else if (input.error instanceof Error && input.error.name === "PermanentPdfError") {
    event.category = "validation";
  } else if (input.stage === "storage_put") {
    event.category = "storage_unavailable";
  } else if (input.stage === "rendering") {
    event.category = "render";
  } else {
    event.category = "unknown";
  }
  if (typeof input.attempt === "number" && Number.isInteger(input.attempt) && input.attempt >= 0 && input.attempt <= 20) {
    event.attempt = input.attempt;
  }
  const networkCode = networkCodeOf(input.error);
  if (networkCode) {
    event.networkCode = networkCode;
  }
  return event;
}

export function pdfFailureErrorCode(stage: WorkerPdfStage, error: unknown): string {
  if (stage !== "storage_put") {
    return "PDF_RENDER_FAILED";
  }
  const category = workerPdfFailureEvent({ stage, error }).category;
  return category === "storage_rejected" ? "STORAGE_REJECTED" : "STORAGE_UNAVAILABLE";
}

export function writeWorkerPdfEvent(
  input: { stage: WorkerPdfStage; sqlstate?: string },
  write: (line: string) => void = console.log,
): void {
  write(JSON.stringify(workerPdfSafeEvent(input)));
}

export function writeWorkerPdfFailure(
  input: { stage: WorkerPdfStage; error: unknown; attempt?: number },
  write: (line: string) => void = console.log,
): void {
  write(JSON.stringify(workerPdfFailureEvent(input)));
}
