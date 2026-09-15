import { loadEnv } from "@job-to-invoice/config";
import { Pool } from "pg";
import { buildApp } from "./app.ts";
import { jwtVerifierFromEnv } from "./jwt.ts";
import { createDocumentsDownloadStore } from "./documents-store.ts";

const env = loadEnv();
const databaseUrl = "DATABASE_URL_API" in env ? env.DATABASE_URL_API : undefined;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 10 }) : undefined;
const documentsStore = env.documentsStorage
  ? createDocumentsDownloadStore(env.documentsStorage)
  : undefined;
const app = buildApp({
  env,
  pool,
  verifyJwt: jwtVerifierFromEnv(env),
  documentsStore,
});
const port = Number(process.env.PORT ?? "3001");

await app.listen({ port, host: "0.0.0.0" });
