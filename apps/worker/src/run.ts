import { loadEnv, r2DocumentsBucket, type LoadedEnv } from "@job-to-invoice/config";
import { Pool } from "pg";
import { processGenerateOriginalPdf } from "./outbox.ts";
import { renderQuoteOriginalPdf } from "./pdf.ts";
import { createR2DocumentsStore } from "./r2.ts";

export function workerStatus(env: LoadedEnv): string {
  return `worker original-pdf (${env.APP_ENV})`;
}

function workerStore(env: LoadedEnv) {
  if (!("R2_ACCOUNT_ID" in env) || !env.R2_ACCOUNT_ID || !env.R2_WORKER_ACCESS_KEY_ID || !env.R2_WORKER_SECRET_ACCESS_KEY) {
    return undefined;
  }
  return createR2DocumentsStore({
    accountId: env.R2_ACCOUNT_ID,
    bucket: r2DocumentsBucket(env.APP_ENV, env.R2_DOCUMENTS_BUCKET),
    accessKeyId: env.R2_WORKER_ACCESS_KEY_ID,
    secretAccessKey: env.R2_WORKER_SECRET_ACCESS_KEY,
  });
}

export async function startWorker(): Promise<string> {
  const env = loadEnv();
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
