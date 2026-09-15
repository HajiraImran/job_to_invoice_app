import { loadEnv, r2DocumentsBucket } from "@job-to-invoice/config";
import { Pool } from "pg";
import { buildApp } from "./app.ts";
import { jwtVerifierFromEnv } from "./jwt.ts";
import { createR2DownloadStore } from "./r2.ts";

const env = loadEnv();
const databaseUrl = "DATABASE_URL_API" in env ? env.DATABASE_URL_API : undefined;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 10 }) : undefined;
const documentsStore =
  env.R2_ACCOUNT_ID && env.R2_API_ACCESS_KEY_ID && env.R2_API_SECRET_ACCESS_KEY
    ? createR2DownloadStore({
        accountId: env.R2_ACCOUNT_ID,
        bucket: r2DocumentsBucket(env.APP_ENV, env.R2_DOCUMENTS_BUCKET),
        accessKeyId: env.R2_API_ACCESS_KEY_ID,
        secretAccessKey: env.R2_API_SECRET_ACCESS_KEY,
      })
    : undefined;
const app = buildApp({
  env,
  pool,
  verifyJwt: jwtVerifierFromEnv(env),
  documentsStore,
});
const port = Number(process.env.PORT ?? "3001");

await app.listen({ port, host: "0.0.0.0" });
