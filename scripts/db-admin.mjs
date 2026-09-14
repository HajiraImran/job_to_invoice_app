import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export async function applyCleanMigrations(client, root) {
  await client.query("reset role");
  await client.query("drop schema if exists commercial cascade");
  await client.query("drop schema if exists identity cascade");
  const dir = join(root, "supabase", "migrations");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    await client.query(readFileSync(join(dir, file), "utf8"));
  }
  await client.query("reset role");
  return files.length;
}
