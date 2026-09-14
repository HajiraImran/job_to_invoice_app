import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const forbiddenRole = ["service", "role"].join("_");

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
  const cluster = new EmbeddedPostgres({
    databaseDir,
    user: "postgres",
    password: "postgres",
    port: 55432,
    persistent: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
  });
  await cluster.initialise();
  await cluster.start();
  return {
    url: "postgres://postgres:postgres@127.0.0.1:55432/postgres",
    stop: async () => {
      await cluster.stop();
    },
  };
}
