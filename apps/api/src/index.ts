import { loadEnv } from "@job-to-invoice/config";
import { buildApp } from "./app.ts";

const env = loadEnv();
const app = buildApp();
const port = Number(process.env.PORT ?? "3001");

await app.listen({ port, host: "0.0.0.0" });
app.log.info({ env: env.APP_ENV }, "api listening");
