import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export async function applyCleanMigrations(client, root) {
  await client.query("reset role");
  await client.query("drop schema if exists commercial cascade");
  await client.query("drop schema if exists identity cascade");
  await client.query(`
    do $cleanup$
    declare
      r text;
    begin
      foreach r in array array['migrator', 'api_app', 'worker_app', 'purge_app']
      loop
        if exists (select 1 from pg_roles where rolname = r) then
          begin
            execute format('revoke %I from current_user', r);
          exception
            when others then
              null;
          end;
          execute format('drop role %I', r);
        end if;
      end loop;
    end
    $cleanup$;
  `);
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
