export const WORKER_PDF_EVENT = "worker_pdf";

export const WORKER_PDF_STAGES = [
  "started",
  "no_work",
  "claimed",
  "rendering",
  "uploading",
  "completed",
  "retry_scheduled",
  "dead",
] as const;

export type WorkerPdfStage = (typeof WORKER_PDF_STAGES)[number];

export const WORKER_PDF_SAFE_KEYS = ["event", "stage"] as const;

export type WorkerPdfSafeEvent = {
  event: typeof WORKER_PDF_EVENT;
  stage: WorkerPdfStage;
};

const STAGE_SET = new Set<string>(WORKER_PDF_STAGES);
const KEY_SET = new Set<string>(WORKER_PDF_SAFE_KEYS);

export function workerPdfSafeEvent(input: { stage: WorkerPdfStage }): WorkerPdfSafeEvent {
  return {
    event: WORKER_PDF_EVENT,
    stage: input.stage,
  };
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
  return record.event === WORKER_PDF_EVENT && typeof record.stage === "string" && STAGE_SET.has(record.stage);
}

export function writeWorkerPdfEvent(
  input: { stage: WorkerPdfStage },
  write: (line: string) => void = console.log,
): void {
  write(JSON.stringify(workerPdfSafeEvent(input)));
}
