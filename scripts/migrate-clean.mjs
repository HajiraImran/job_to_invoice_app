import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.DATABASE_URL_MIGRATIONS;

if (!url) {
  console.error("DATABASE_URL_MIGRATIONS is required for migrate:clean");
  process.exit(1);
}

const forbiddenRole = ["service", "role"].join("_");
if (url.toLowerCase().includes(forbiddenRole)) {
  console.error("migrate:clean refuses a privileged Supabase connection string");
  process.exit(1);
}

const dir = join(root, "supabase", "migrations");
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const client = new Client({ connectionString: url });
await client.connect();
try {
  await client.query("drop schema if exists commercial cascade");
  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf8");
    await client.query(sql);
  }
  const testSql = readFileSync(join(root, "supabase", "tests", "0001_foundation.sql"), "utf8");
  const result = await client.query(testSql);
  if (result.rowCount !== 1) {
    throw new Error("foundation schema test failed");
  }
  console.log(`Applied ${files.length} migration(s) on a clean database.`);
} finally {
  await client.end();
}
