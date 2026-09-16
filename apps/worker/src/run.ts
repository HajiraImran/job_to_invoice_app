import { loadWorkerEnv, type LoadedEnv, type LoadedWorkerEnv } from "@job-to-invoice/config";
import { Pool } from "pg";
import { processGenerateOriginalPdf } from "./outbox.ts";
import { renderQuoteOriginalPdf } from "./pdf.ts";
import { createDocumentsObjectStore } from "./documents-store.ts";

export function workerStatus(env: LoadedEnv | LoadedWorkerEnv): string {
  return `worker original-pdf (${env.APP_ENV})`;
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
  const databaseUrl = "DATABASE_URL_WORKER" in env ? env.DATABASE_URL_WORKER : undefined;
  if (!databaseUrl || process.env.WORKER_ONCE === "true") {
    return status;
  }
  const store = workerStore(env);
  if (!store) {
    return status;
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  setInterval(() => {
    void processGenerateOriginalPdf({ pool, store, render: renderQuoteOriginalPdf }).catch(() => undefined);
  }, 2000);
  return status;
}
