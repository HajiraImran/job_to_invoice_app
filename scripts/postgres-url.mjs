import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const forbiddenRole = ["service", "role"].join("_");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

export async function resolveMigrationsUrl() {
  const fromEnv = process.env.DATABASE_URL_MIGRATIONS;
  if (fromEnv) {
    if (fromEnv.toLowerCase().includes(forbiddenRole)) {
      throw new Error("DATABASE_URL_MIGRATIONS must not use a privileged Supabase role");
    }
    return { url: fromEnv, stop: async () => {} };
  }

  const EmbeddedPostgres = (await import("embedded-postgres")).default;
  const databaseDir = await mkdtemp(join(tmpdir(), "jti-pg-"));
  const port = await freePort();
  const cluster = new EmbeddedPostgres({
    databaseDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
  });
  await cluster.initialise();
  await cluster.start();
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    stop: async () => {
      await cluster.stop();
    },
  };
}
