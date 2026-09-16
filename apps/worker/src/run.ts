import { loadWorkerEnv, type LoadedEnv, type LoadedWorkerEnv } from "@job-to-invoice/config";
import { processGenerateOriginalPdf } from "./outbox.ts";
import { renderQuoteOriginalPdf } from "./pdf.ts";
import { createDocumentsObjectStore } from "./documents-store.ts";
import { createWorkerPool, workerStageFromError } from "./db.ts";
import { writeWorkerPdfEvent, type WorkerPdfStage } from "./worker-log.ts";

export const WORKER_POLL_MS = 2_000;
export const WORKER_NO_WORK_EVERY_MS = 30_000;

export function workerStatus(env: LoadedEnv | LoadedWorkerEnv): string {
  return `worker original-pdf (${env.APP_ENV})`;
}

export function workerPollReady(env: LoadedWorkerEnv): "ready" | "missing_database" | "missing_storage" {
  const databaseUrl = "DATABASE_URL_WORKER" in env ? env.DATABASE_URL_WORKER : undefined;
  if (!databaseUrl) {
    return "missing_database";
  }
  if (!env.documentsStorage) {
    return "missing_storage";
  }
  return "ready";
}

export function createWorkerTick(input: {
  run: () => Promise<"idle" | "done" | "retry" | "dead">;
  onStage?: (stage: WorkerPdfStage, sqlstate?: string) => void;
  now?: () => number;
  noWorkEveryMs?: number;
}): () => Promise<void> {
  let busy = false;
  let lastNoWorkAt = 0;
  const everyMs = input.noWorkEveryMs ?? WORKER_NO_WORK_EVERY_MS;
  return async () => {
    if (busy) {
      return;
    }
    busy = true;
    try {
      const result = await input.run();
      if (result !== "idle") {
        return;
      }
      const now = (input.now ?? Date.now)();
      if (now - lastNoWorkAt < everyMs && lastNoWorkAt !== 0) {
        return;
      }
      lastNoWorkAt = now;
      input.onStage?.("no_work");
    } catch (error) {
      const failed = workerStageFromError(error);
      if (failed) {
        input.onStage?.(failed.stage, failed.sqlstate);
      }
    } finally {
      busy = false;
    }
  };
}

export async function startWorkerPolling(input: {
  run: () => Promise<"idle" | "done" | "retry" | "dead">;
  onStage?: (stage: WorkerPdfStage, sqlstate?: string) => void;
  now?: () => number;
  noWorkEveryMs?: number;
  pollMs?: number;
  schedule?: (tick: () => void, delayMs: number) => ReturnType<typeof setInterval>;
}): Promise<{ tick: () => Promise<void>; stop: () => void }> {
  input.onStage?.("started");
  const tick = createWorkerTick(input);
  await tick();
  const handle = (input.schedule ?? setInterval)(() => {
    void tick();
  }, input.pollMs ?? WORKER_POLL_MS);
  return {
    tick,
    stop: () => {
      clearInterval(handle);
    },
  };
}

function workerStore(env: LoadedWorkerEnv) {
  if (!env.documentsStorage) {
    return undefined;
  }
  return createDocumentsObjectStore(env.documentsStorage);
}

export async function startWorker(): Promise<string> {
  const env = loadWorkerEnv();
  const status = workerStatus(env);
  if (process.env.WORKER_ONCE === "true") {
    writeWorkerPdfEvent({ stage: "started" });
    return status;
  }
  const ready = workerPollReady(env);
  if (ready !== "ready") {
    throw new Error(
      `Invalid ${env.APP_ENV} configuration (QA68): ${
        ready === "missing_database" ? "worker database URL is required" : "worker storage configuration is required"
      }`,
    );
  }
  const databaseUrl = env.DATABASE_URL_WORKER;
  const store = workerStore(env);
  if (!databaseUrl || !store) {
    throw new Error(`Invalid ${env.APP_ENV} configuration (QA68): worker storage configuration is required`);
  }
  const pool = createWorkerPool(databaseUrl);
  const writeStage = (stage: WorkerPdfStage, sqlstate?: string) => writeWorkerPdfEvent({ stage, sqlstate });
  await startWorkerPolling({
    run: () =>
      processGenerateOriginalPdf({
        pool,
        store,
        render: renderQuoteOriginalPdf,
        onStage: writeStage,
      }),
    onStage: writeStage,
  });
  return status;
}
