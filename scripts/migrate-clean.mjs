import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { applyCleanMigrations } from "./db-admin.mjs";
import { resolveMigrationsUrl } from "./postgres-url.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { url, stop } = await resolveMigrationsUrl();

const client = new Client({ connectionString: url });
await client.connect();

try {
  const count = await applyCleanMigrations(client, root);
  console.log(`Applied ${count} migration(s) on a clean database.`);
  const smoke = await client.query(`
    select
      (select count(*)::int from information_schema.schemata where schema_name in ('commercial', 'identity')) as schemas,
      (select count(*)::int from pg_roles where rolname in ('migrator', 'api_app', 'worker_app', 'purge_app')) as roles
  `);
  const row = smoke.rows[0];
  if (row.schemas !== 2 || row.roles !== 4) {
    throw new Error(`foundation smoke failed: schemas=${row.schemas} roles=${row.roles}`);
  }
} finally {
  await client.end();
  await stop();
}
