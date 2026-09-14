import Fastify from "fastify";

export function buildApp() {
  const app = Fastify({ logger: false });
  app.get("/v1/health", async () => ({
    data: { status: "ok", product: false },
    meta: { note: "Foundation scaffold. Commercial routes are not implemented." },
  }));
  return app;
}
