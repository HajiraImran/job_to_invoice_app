export const WORKER_PDF_EVENT = "worker_pdf";

export const WORKER_PDF_STAGES = [
  "started",
  "claim_started",
  "no_work",
  "claimed",
  "rendering",
  "uploading",
  "completed",
  "retry_scheduled",
  "dead",
  "database_connect_failed",
  "transaction_start_failed",
  "set_role_failed",
  "claim_query_failed",
  "claim_timed_out",
] as const;

export type WorkerPdfStage = (typeof WORKER_PDF_STAGES)[number];

export const WORKER_PDF_SAFE_KEYS = ["event", "stage"] as const;
export const WORKER_PDF_OPTIONAL_KEYS = ["sqlstate"] as const;

export type WorkerPdfSafeEvent = {
  event: typeof WORKER_PDF_EVENT;
  stage: WorkerPdfStage;
  sqlstate?: string;
};

const STAGE_SET = new Set<string>(WORKER_PDF_STAGES);
const KEY_SET = new Set<string>([...WORKER_PDF_SAFE_KEYS, ...WORKER_PDF_OPTIONAL_KEYS]);
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
  return record.event === WORKER_PDF_EVENT && typeof record.stage === "string" && STAGE_SET.has(record.stage);
}

export function writeWorkerPdfEvent(
  input: { stage: WorkerPdfStage; sqlstate?: string },
  write: (line: string) => void = console.log,
): void {
  write(JSON.stringify(workerPdfSafeEvent(input)));
}
