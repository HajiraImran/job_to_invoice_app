import "./align-portal-origin.ts";
import { loadApiEnv } from "@job-to-invoice/config";
import { buildApp } from "./app.ts";
import { createApiPool, startPoolHeartbeat, warmApiPool } from "./db.ts";
import { jwtVerifierFromEnv } from "./jwt.ts";
import { createDocumentsDownloadStore } from "./documents-store.ts";
import { writeApiRequestEvent } from "./request-context.ts";

const env = loadApiEnv();
const databaseUrl = "DATABASE_URL_API" in env ? env.DATABASE_URL_API : undefined;
const pool = databaseUrl
  ? createApiPool(databaseUrl, {
      attemptTimeoutMs: env.databaseConnectAttemptTimeoutMs,
      deadlineMs: env.databaseConnectDeadlineMs,
    })
  : undefined;
const documentsStore = env.documentsStorage
  ? createDocumentsDownloadStore(env.documentsStorage)
  : undefined;
const app = buildApp({
  env,
  pool,
  verifyJwt: jwtVerifierFromEnv(env),
  documentsStore,
  logRequest: writeApiRequestEvent,
});
const port = Number(process.env.PORT ?? "3001");

await app.listen({ port, host: "0.0.0.0" });

if (pool) {
  const startedAt = Date.now();
  void warmApiPool(pool).then((ready) => {
    process.stdout.write(`${JSON.stringify({ event: "db_pool_warm", ready, ms: Date.now() - startedAt })}\n`);
    startPoolHeartbeat(pool);
  });
}
