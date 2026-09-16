import { readdirSync, readFileSync } from "node:fs";
import { Client, Pool } from "pg";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCleanMigrations } from "./db-admin.mjs";
import { resolveMigrationsUrl } from "./postgres-url.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const A = {
  user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  auth: "aaaa1111-aaaa-4111-8aaa-aaaaaaaaaaaa",
  ws: "11111111-1111-4111-8111-111111111111",
  mem: "aaaa2222-aaaa-4222-8222-aaaaaaaaaaaa",
  asset: "aaaa3333-aaaa-4333-8333-aaaaaaaaaaaa",
  customer: "aaaa4444-aaaa-4444-8444-aaaaaaaaaaaa",
  job: "aaaa5555-aaaa-4555-8555-aaaaaaaaaaaa",
  draft: "aaaa6666-aaaa-4666-8666-aaaaaaaaaaaa",
  doc: "aaaa7777-aaaa-4777-8777-aaaaaaaaaaaa",
};
const B = {
  user: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  auth: "bbbb1111-bbbb-4111-8bbb-bbbbbbbbbbbb",
  ws: "22222222-2222-4222-8222-222222222222",
  mem: "bbbb2222-bbbb-4222-8222-bbbbbbbbbbbb",
  asset: "bbbb3333-bbbb-4333-8333-bbbbbbbbbbbb",
  customer: "bbbb4444-bbbb-4444-8444-bbbbbbbbbbbb",
  job: "bbbb5555-bbbb-4555-8555-bbbbbbbbbbbb",
  draft: "bbbb6666-bbbb-4666-8666-bbbbbbbbbbbb",
  doc: "bbbb7777-bbbb-4777-8777-bbbbbbbbbbbb",
};

class Fail extends Error {}

function assert(condition, message) {
  if (!condition) {
    throw new Fail(message);
  }
}

async function expectFail(fn, pattern, message) {
  try {
    await fn();
    throw new Fail(`${message}: expected failure`);
  } catch (error) {
    if (error instanceof Fail) {
      throw error;
    }
    const text = String(error.message ?? error);
    assert(pattern.test(text), `${message}: unexpected error: ${text}`);
  }
}

function splitSqlStatements(sql) {
  const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
  const statements = [];
  let current = "";
  let i = 0;
  let dollarTag = null;
  while (i < stripped.length) {
    if (dollarTag) {
      const end = stripped.indexOf(dollarTag, i);
      if (end === -1) {
        current += stripped.slice(i);
        break;
      }
      current += stripped.slice(i, end + dollarTag.length);
      i = end + dollarTag.length;
      dollarTag = null;
      continue;
    }
    if (stripped[i] === "'") {
      current += stripped[i++];
      while (i < stripped.length) {
        if (stripped[i] === "'" && stripped[i + 1] === "'") {
          current += "''";
          i += 2;
          continue;
        }
        current += stripped[i];
        if (stripped[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    const dollar = stripped.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
    if (dollar) {
      dollarTag = dollar[0];
      current += dollar[0];
      i += dollar[0].length;
      continue;
    }
    if (stripped[i] === ";") {
      const stmt = current.trim();
      if (stmt) {
        statements.push(stmt);
      }
      current = "";
      i += 1;
      continue;
    }
    current += stripped[i];
    i += 1;
  }
  const tail = current.trim();
  if (tail) {
    statements.push(tail);
  }
  return statements;
}

async function insertUser(admin, person, email) {
  await admin.query(
    `insert into identity.app_users (
      id, auth_user_id, normalized_email, display_email, status,
      last_authenticated_at, terms_version, privacy_version
    ) values ($1, $2, $3, $4, 'active', now(), '1', '1')`,
    [person.user, person.auth, email, email],
  );
}

async function insertWorkspace(admin, person) {
  await admin.query(
    `insert into commercial.workspaces (
      workspace_id, id, owner_user_id, business_name, legal_name, contact_name,
      contact_email, timezone, trade, default_terms
    ) values ($1, $1, $2, $3, $3, $3, $4, 'America/New_York', 'handyman', 'Net 14')`,
    [person.ws, person.user, `Biz ${person.ws.slice(0, 4)}`, `owner@${person.ws.slice(0, 4)}.example`],
  );
  await admin.query(
    `insert into commercial.memberships (
      workspace_id, id, user_id, role, status
    ) values ($1, $2, $3, 'owner', 'active')`,
    [person.ws, person.mem, person.user],
  );
  await admin.query(
    `insert into commercial.assets (
      workspace_id, id, visibility, bucket_key, upload_state, media_type, source_size, uploaded_by
    ) values ($1, $2, 'internal', $3, 'ready', 'image/png', 12, $4)`,
    [person.ws, person.asset, `logos/${person.ws}.png`, person.user],
  );
  await admin.query(
    `insert into commercial.customers (workspace_id, id, name)
     values ($1, $2, $3)`,
    [person.ws, person.customer, `Customer ${person.ws.slice(0, 4)}`],
  );
  await admin.query(
    `insert into commercial.jobs (
      workspace_id, id, customer_id, title, no_site, lifecycle, mode
    ) values ($1, $2, $3, $4, true, 'draft', 'quote')`,
    [person.ws, person.job, person.customer, `Job ${person.ws.slice(0, 4)}`],
  );
  await admin.query(
    `insert into commercial.document_drafts (
      workspace_id, id, job_id, kind, payload_json, draft_state
    ) values ($1, $2, $3, 'quote', $4::jsonb, 'editing')`,
    [
      person.ws,
      person.draft,
      person.job,
      JSON.stringify({ notes: "", terms: "", expiry_days: 14, lines: [] }),
    ],
  );
  const snapshot = JSON.stringify({
    schema_version: 1,
    kind: "quote",
    currency: "USD",
    notes: "",
    terms: "",
    lines: [],
  });
  await admin.query(
    `insert into commercial.documents (
      workspace_id, id, created_by, job_id, kind, number, revision_no, lifecycle,
      issued_at, issue_date, currency, net_cents, tax_cents, total_cents,
      snapshot_json, canonical_snapshot_bytes, schema_version, snapshot_sha256
    ) values ($1, $2, $3, $4, 'quote', 'Q-000001', 1, 'issued', now(), current_date, 'USD', 0, 0, 0, $5::jsonb, $6::bytea, 1, $7)`,
    [person.ws, person.doc, person.user, person.job, snapshot, Buffer.from("{}"), "ab".repeat(32)],
  );
}

async function withApi(admin, fn) {
  await admin.query("begin");
  try {
    await admin.query("set role api_app");
    const result = await fn();
    await admin.query("reset role");
    await admin.query("commit");
    return result;
  } catch (error) {
    try {
      await admin.query("rollback");
    } catch {
      /* already rolled back */
    }
    try {
      await admin.query("reset role");
    } catch {
      /* already reset */
    }
    throw error;
  }
}

const { url, stop } = await resolveMigrationsUrl();
const admin = new Client({ connectionString: url });
await admin.connect();
let failed = 0;
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok ${name}`);
    console.error(error instanceof Error ? error.message : error);
  }
}

try {
  await admin.query(`
    create schema if not exists supabase_migrations authorization current_user;
    drop table if exists supabase_migrations.schema_migrations;
    create table supabase_migrations.schema_migrations (
      version text primary key,
      name text not null,
      statements text[]
    );
    revoke all on schema supabase_migrations from public;
    revoke all on table supabase_migrations.schema_migrations from public;
  `);
  await applyCleanMigrations(admin, root, {
    afterEach: async (file) => {
      const who = await admin.query("select current_user as current_role, session_user as session_role");
      assert(
        who.rows[0].current_role === who.rows[0].session_role,
        `${file} must RESET ROLE before returning to the bootstrap session user`,
      );
      assert(who.rows[0].current_role !== "migrator", `${file} left SET ROLE migrator in effect`);
      if (file.startsWith("0001")) {
        await admin.query("revoke all on schema supabase_migrations from migrator");
        await admin.query("revoke all on table supabase_migrations.schema_migrations from migrator");
      }
      await admin.query(
        `insert into supabase_migrations.schema_migrations(version, name, statements)
         values ($1, $2, $3)`,
        [file.slice(0, 4), file.replace(/\.sql$/, ""), ["applied"]],
      );
    },
  });
  await test("0009 grants worker_app membership so SET LOCAL ROLE worker_app succeeds", async () => {
    const attrs = await admin.query(`
      select rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
      from pg_roles
      where rolname = 'worker_app'
    `);
    const role = attrs.rows[0];
    assert(role, "worker_app must exist");
    assert(role.rolcanlogin === false, "worker_app must remain nologin");
    assert(role.rolsuper === false, "worker_app must not be superuser");
    assert(role.rolbypassrls === false, "worker_app must not bypass RLS");
    assert(role.rolcreatedb === false, "worker_app must not createdb");
    assert(role.rolcreaterole === false, "worker_app must not createrole");
    assert(role.rolreplication === false, "worker_app must not replicate");
    const membership = await admin.query(
      "select pg_has_role(current_user, 'worker_app', 'MEMBER') as member",
    );
    assert(
      membership.rows[0].member === true,
      "migration current_user must be a member of worker_app after 0009",
    );
    await admin.query("begin");
    try {
      await admin.query("set local role worker_app");
      const who = await admin.query("select current_user as role");
      assert(who.rows[0].role === "worker_app", "SET LOCAL ROLE worker_app must succeed");
      await expectFail(
        () => admin.query("select id from commercial.documents"),
        /permission denied/i,
        "worker_app documents select",
      );
    } finally {
      await admin.query("rollback");
    }
  });
  await admin.query(
    "grant api_app, worker_app, purge_app, anon, authenticated, migrator to current_user",
  );

  const testsDir = join(root, "supabase", "tests");
  for (const file of readdirSync(testsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    await test(`sql ${file}`, async () => {
      const result = await admin.query(readFileSync(join(testsDir, file), "utf8"));
      const row = result.rows[0];
      assert(row, `${file} returned no row`);
      if ("ok" in row) {
        assert(row.ok === true, `${file} ok=false`);
      }
      if ("force_rls" in row) {
        assert(row.force_rls === true, `${file} FORCE RLS missing`);
      }
      if ("owned_by_migrator" in row) {
        assert(row.owned_by_migrator === true, `${file} tables not owned by migrator`);
      }
      if ("migrator_policy" in row) {
        assert(row.migrator_policy === true, `${file} FORCE RLS tables missing migrator owner policy`);
      }
    });
  }

  await test("roles are distinct and api/worker/purge cannot bypass RLS", async () => {
    const roles = await admin.query(`
      select rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreatedb, rolcreaterole, rolreplication
      from pg_roles
      where rolname in ('migrator', 'api_app', 'worker_app', 'purge_app')
      order by rolname
    `);
    const byName = Object.fromEntries(roles.rows.map((row) => [row.rolname, row]));
    assert(Object.keys(byName).length === 4, "expected four application roles");
    for (const name of ["migrator", "api_app", "worker_app", "purge_app"]) {
      const role = byName[name];
      assert(role.rolsuper === false, `${name} must not be superuser`);
      assert(role.rolbypassrls === false, `${name} must not bypass RLS`);
      assert(role.rolcanlogin === false, `${name} must be nologin`);
      assert(role.rolcreatedb === false, `${name} must not createdb`);
      assert(role.rolcreaterole === false, `${name} must not createrole`);
      assert(role.rolreplication === false, `${name} must not replicate`);
    }
    assert(byName.api_app !== byName.worker_app, "roles must be distinct");
  });

  await test("application migrations contain no ALTER ROLE", async () => {
    const dir = join(root, "supabase", "migrations");
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql"))) {
      const sql = readFileSync(join(dir, file), "utf8")
        .replace(/--[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      assert(!/\balter\s+role\b/i.test(sql), `${file} must not contain ALTER ROLE`);
      assert(!/\balter\s+role\s+anon\b/i.test(sql), `${file} must not alter anon`);
      assert(!/\balter\s+role\s+authenticated\b/i.test(sql), `${file} must not alter authenticated`);
    }
  });

  await test("0009 grants only worker_app membership to current_user", async () => {
    const sql = readFileSync(join(root, "supabase", "migrations", "0009_worker_app_membership.sql"), "utf8")
      .replace(/--[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .trim();
    assert(
      /^\s*grant\s+worker_app\s+to\s+current_user\s*;\s*$/i.test(sql),
      "0009 must grant only worker_app to current_user",
    );
    assert(!/\bpassword\b/i.test(sql), "0009 must not contain a password");
    assert(!/\bgrant\s+(migrator|api_app|purge_app|anon|authenticated)\b/i.test(sql), "0009 must not grant other roles");
  });

  await test("SET ROLE migrations end with RESET ROLE and nothing after it", async () => {
    const dir = join(root, "supabase", "migrations");
    let setRoleFiles = 0;
    for (const file of readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      const statements = splitSqlStatements(readFileSync(join(dir, file), "utf8"));
      const setRoleAt = statements.findIndex((stmt) => /^set\s+role\b/i.test(stmt));
      const resetAt = statements.findIndex((stmt) => /^reset\s+role$/i.test(stmt));
      if (setRoleAt === -1) {
        assert(resetAt === -1, `${file} RESET ROLE without SET ROLE`);
        continue;
      }
      setRoleFiles += 1;
      assert(/^set\s+role\s+migrator$/i.test(statements[setRoleAt]), `${file} must SET ROLE migrator`);
      assert(resetAt === statements.length - 1, `${file} must end with RESET ROLE`);
      assert(
        statements.filter((stmt) => /^reset\s+role$/i.test(stmt)).length === 1,
        `${file} must RESET ROLE only once, after migrator-owned objects exist`,
      );
      assert(setRoleAt < resetAt, `${file} RESET ROLE must not precede SET ROLE`);
    }
    assert(setRoleFiles === 7, "expected SET ROLE migrator in 0002, 0003, 0004, 0005, 0006, 0007, and 0008");
  });

  await test("migration history inserts succeed as the restored bootstrap role", async () => {
    const recorded = await admin.query(
      "select version from supabase_migrations.schema_migrations order by version",
    );
    assert(
      recorded.rows.map((row) => row.version).join(",") === "0001,0002,0003,0004,0005,0006,0007,0008,0009",
      "bootstrap role must record 0001-0009 after RESET ROLE",
    );
    await admin.query("set role migrator");
    try {
      await expectFail(
        () =>
          admin.query(
            `insert into supabase_migrations.schema_migrations(version, name, statements)
             values ('9999', 'must_fail', array['no'])`,
          ),
        /permission denied/i,
        "migrator history insert",
      );
    } finally {
      await admin.query("reset role");
    }
  });

  const foundationSql = readFileSync(join(root, "supabase", "migrations", "0001_foundation.sql"), "utf8");
  const restoreMigrator =
    "alter role migrator with nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls";
  const unsafeAttributes = [
    { name: "LOGIN", clause: "login" },
    { name: "SUPERUSER", clause: "superuser" },
    { name: "CREATEDB", clause: "createdb" },
    { name: "CREATEROLE", clause: "createrole" },
    { name: "REPLICATION", clause: "replication" },
    { name: "BYPASSRLS", clause: "bypassrls" },
  ];
  for (const attr of unsafeAttributes) {
    await test(`bootstrap rejects pre-existing ${attr.name} application roles`, async () => {
      await admin.query(`alter role migrator with ${attr.clause}`);
      try {
        await expectFail(
          () => admin.query(foundationSql),
          new RegExp(`D-010[\\s\\S]*${attr.name}`),
          `unsafe migrator ${attr.name}`,
        );
      } finally {
        await admin.query(restoreMigrator);
      }
    });
  }

  await test("bootstrap does not alter or drop anon or authenticated", async () => {
    const before = await admin.query(`
      select oid, rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      from pg_roles
      where rolname in ('anon', 'authenticated')
      order by rolname
    `);
    assert(before.rows.length === 2, "anon and authenticated must exist before re-bootstrap");
    await admin.query(foundationSql);
    const after = await admin.query(`
      select oid, rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      from pg_roles
      where rolname in ('anon', 'authenticated')
      order by rolname
    `);
    assert(
      JSON.stringify(before.rows) === JSON.stringify(after.rows),
      "anon and authenticated must be unchanged after re-bootstrap",
    );
  });

  await test("local clean setup drops only the four application roles", async () => {
    const beforeClients = await admin.query(`
      select oid, rolname
      from pg_roles
      where rolname in ('anon', 'authenticated')
      order by rolname
    `);
    await admin.query("alter role migrator with login");
    await applyCleanMigrations(admin, root);
    await admin.query(
      "grant api_app, worker_app, purge_app, anon, authenticated, migrator to current_user",
    );
    const afterClients = await admin.query(`
      select oid, rolname
      from pg_roles
      where rolname in ('anon', 'authenticated')
      order by rolname
    `);
    assert(
      JSON.stringify(beforeClients.rows) === JSON.stringify(afterClients.rows),
      "anon and authenticated must survive local cleanup",
    );
    const migrator = await admin.query(`
      select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      from pg_roles
      where rolname = 'migrator'
    `);
    assert(migrator.rows[0].rolcanlogin === false, "cleanup must recreate migrator as nologin");
    assert(migrator.rows[0].rolsuper === false, "cleanup must recreate migrator as nonsuperuser");
    assert(migrator.rows[0].rolcreatedb === false, "cleanup must recreate migrator as nocreatedb");
    assert(migrator.rows[0].rolcreaterole === false, "cleanup must recreate migrator as nocreaterole");
    assert(migrator.rows[0].rolreplication === false, "cleanup must recreate migrator as noreplication");
    assert(migrator.rows[0].rolbypassrls === false, "cleanup must recreate migrator as nobypassrls");
  });

  await test("tenant tables enable and force RLS and are owned by migrator", async () => {
    const tables = await admin.query(`
      select n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) as owner
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('identity', 'commercial') and c.relkind = 'r'
    `);
    assert(tables.rows.length >= 5, "expected identity and commercial tables");
    for (const row of tables.rows) {
      assert(row.relrowsecurity === true, `${row.nspname}.${row.relname} RLS off`);
      assert(row.relforcerowsecurity === true, `${row.nspname}.${row.relname} FORCE RLS off`);
      assert(row.owner === "migrator", `${row.nspname}.${row.relname} owner is ${row.owner}`);
    }
    const leakedOwners = await admin.query(`
      select kind, name
      from (
        select 'schema'::text as kind, n.nspname as name
        from pg_namespace n
        where n.nspname in ('identity', 'commercial')
          and pg_get_userbyid(n.nspowner) <> 'migrator'
        union all
        select 'relation', n.nspname || '.' || c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('identity', 'commercial')
          and pg_get_userbyid(c.relowner) <> 'migrator'
        union all
        select 'function', n.nspname || '.' || p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('identity', 'commercial')
          and pg_get_userbyid(p.proowner) <> 'migrator'
      ) leaked
    `);
    assert(
      leakedOwners.rows.length === 0,
      `objects not owned by migrator: ${leakedOwners.rows.map((row) => `${row.kind} ${row.name}`).join(", ")}`,
    );
  });

  await test("every FORCE RLS table has the migrator owner policy and no runtime equivalent", async () => {
    const missing = await admin.query(`
      select n.nspname || '.' || c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('identity', 'commercial')
        and c.relkind = 'r'
        and c.relforcerowsecurity
        and not exists (
          select 1
          from pg_policy p
          where p.polrelid = c.oid
            and p.polname = n.nspname || '_' || c.relname || '_migrator_all'
            and p.polcmd = '*'
            and p.polroles = array[(select oid from pg_roles where rolname = 'migrator')]::oid[]
            and pg_get_expr(p.polqual, p.polrelid) in ('true', '(true)')
            and pg_get_expr(p.polwithcheck, p.polrelid) in ('true', '(true)')
        )
    `);
    assert(
      missing.rows.length === 0,
      `FORCE RLS tables missing migrator owner policy: ${missing.rows.map((row) => row.table_name).join(", ")}`,
    );
    const leaked = await admin.query(`
      select n.nspname || '.' || c.relname as table_name, p.polname
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('identity', 'commercial')
        and p.polcmd = '*'
        and pg_get_expr(p.polqual, p.polrelid) in ('true', '(true)')
        and (
          0 = any (p.polroles)
          or exists (
            select 1 from pg_roles r
            where r.oid = any (p.polroles)
              and r.rolname in ('api_app', 'worker_app', 'purge_app', 'anon', 'authenticated')
          )
        )
    `);
    assert(leaked.rows.length === 0, "unrestricted FOR ALL policy leaked to a runtime or client role");
  });

  await insertUser(admin, A, "a@example.com");
  await insertUser(admin, B, "b@example.com");
  await insertWorkspace(admin, A);
  await insertWorkspace(admin, B);

  await test("migrator owner policy allows DML without BYPASSRLS", async () => {
    await admin.query("begin");
    try {
      await admin.query("set local role migrator");
      const seen = await admin.query("select count(*)::int as n from commercial.workspaces");
      assert(seen.rows[0].n >= 2, "migrator must see FORCE RLS rows via owner policy");
    } finally {
      await admin.query("commit");
    }
  });

  await test("workspace A can read its own records", async () => {
    const rows = await withApi(admin, async () => {
      await admin.query("select identity.set_local_tenant_context($1, $2)", [A.ws, A.user]);
      const ws = await admin.query("select id from commercial.workspaces");
      const mem = await admin.query("select user_id from commercial.memberships");
      const assets = await admin.query("select id from commercial.assets");
      const jobs = await admin.query("select id from commercial.jobs");
      const drafts = await admin.query("select id from commercial.document_drafts");
      const docs = await admin.query("select id from commercial.documents");
      const me = await admin.query("select id from identity.app_users");
      return { ws, mem, assets, jobs, drafts, docs, me };
    });
    assert(rows.ws.rows.length === 1 && rows.ws.rows[0].id === A.ws, "A should see own workspace");
    assert(rows.mem.rows.length === 1 && rows.mem.rows[0].user_id === A.user, "A should see own membership");
    assert(rows.assets.rows.length === 1 && rows.assets.rows[0].id === A.asset, "A should see own asset");
    assert(rows.jobs.rows.length === 1 && rows.jobs.rows[0].id === A.job, "A should see own job");
    assert(rows.drafts.rows.length === 1 && rows.drafts.rows[0].id === A.draft, "A should see own quote draft");
    assert(rows.docs.rows.length === 1 && rows.docs.rows[0].id === A.doc, "A should see own published quote");
    assert(rows.me.rows.length === 1 && rows.me.rows[0].id === A.user, "A should see own app_user");
  });

  await test("workspace A cannot read workspace B", async () => {
    const rows = await withApi(admin, async () => {
      await admin.query("select identity.set_local_tenant_context($1, $2)", [A.ws, A.user]);
      const ws = await admin.query("select id from commercial.workspaces where id = $1", [B.ws]);
      const assets = await admin.query("select id from commercial.assets where id = $1", [B.asset]);
      const jobs = await admin.query("select id from commercial.jobs where id = $1", [B.job]);
      const drafts = await admin.query("select id from commercial.document_drafts where id = $1", [B.draft]);
      const docs = await admin.query("select id from commercial.documents where id = $1", [B.doc]);
      const users = await admin.query("select id from identity.app_users where id = $1", [B.user]);
      return { ws, assets, jobs, drafts, docs, users };
    });
    assert(rows.ws.rows.length === 0, "A must not see B workspace");
    assert(rows.assets.rows.length === 0, "A must not see B asset");
    assert(rows.jobs.rows.length === 0, "A must not see B job");
    assert(rows.drafts.rows.length === 0, "A must not see B quote draft");
    assert(rows.docs.rows.length === 0, "A must not see B published quote");
    assert(rows.users.rows.length === 0, "A must not see B user");
  });

  await test("workspace A cannot insert, update or delete workspace B", async () => {
    await withApi(admin, async () => {
      await admin.query("select identity.set_local_tenant_context($1, $2)", [A.ws, A.user]);
      const updated = await admin.query("update commercial.workspaces set business_name = 'hijack' where id = $1", [
        B.ws,
      ]);
      assert(updated.rowCount === 0, "A must not update B workspace");
      const deleted = await admin.query("delete from commercial.assets where id = $1", [B.asset]);
      assert(deleted.rowCount === 0, "A must not delete B asset");
    });
    await expectFail(
      () =>
        withApi(admin, async () => {
          await admin.query("select identity.set_local_tenant_context($1, $2)", [A.ws, A.user]);
          await admin.query(
            `insert into commercial.assets (
              workspace_id, id, visibility, bucket_key, upload_state, media_type, source_size, uploaded_by
            ) values ($1, gen_random_uuid(), 'internal', 'x', 'pending', 'image/png', 1, $2)`,
            [B.ws, A.user],
          );
        }),
      /row-level security/i,
      "A insert into B",
    );
    await expectFail(
      () =>
        withApi(admin, async () => {
          await admin.query("select identity.set_local_tenant_context($1, $2)", [A.ws, A.user]);
          await admin.query(
            `insert into commercial.jobs (
              workspace_id, id, customer_id, title, no_site, lifecycle, mode
            ) values ($1, gen_random_uuid(), $2, 'hijack', true, 'draft', 'quote')`,
            [B.ws, B.customer],
          );
        }),
      /row-level security/i,
      "A insert job into B",
    );
    const still = await admin.query("select business_name from commercial.workspaces where id = $1", [B.ws]);
    assert(still.rows[0].business_name.startsWith("Biz"), "B workspace must be unchanged");
  });

  await test("a forged workspace_id does not grant access", async () => {
    const rows = await withApi(admin, async () => {
      await admin.query("select identity.set_local_tenant_context($1, $2)", [B.ws, A.user]);
      const ws = await admin.query("select id from commercial.workspaces");
      const assets = await admin.query("select id from commercial.assets");
      const jobs = await admin.query("select id from commercial.jobs");
      return { ws, assets, jobs };
    });
    assert(rows.ws.rows.length === 0, "forged GUC must not reveal B workspace");
    assert(rows.assets.rows.length === 0, "forged GUC must not reveal B assets");
    assert(rows.jobs.rows.length === 0, "forged GUC must not reveal B jobs");
  });

  await test("a cross-tenant foreign-key reference fails", async () => {
    await expectFail(
      () =>
        admin.query("update commercial.workspaces set logo_asset_id = $1 where id = $2", [B.asset, A.ws]),
      /foreign key/i,
      "cross-tenant logo_asset_id",
    );
    await expectFail(
      () =>
        admin.query("update commercial.jobs set customer_id = $1 where id = $2", [B.customer, A.job]),
      /foreign key/i,
      "cross-tenant job customer_id",
    );
    await expectFail(
      () =>
        admin.query("update commercial.document_drafts set job_id = $1 where id = $2", [B.job, A.draft]),
      /foreign key|immutable/i,
      "cross-tenant quote draft job_id",
    );
    await expectFail(
      () =>
        admin.query("update commercial.assets set draft_id = $1 where id = $2", [B.draft, A.asset]),
      /foreign key/i,
      "cross-tenant asset draft_id",
    );
  });

  await test("completion_right cannot be cleared except by purge_app", async () => {
    await admin.query("update commercial.jobs set completion_right = true where id = $1", [A.job]);
    await expectFail(
      () => admin.query("update commercial.jobs set completion_right = false where id = $1", [A.job]),
      /write-once|completion_right/i,
      "clear completion_right",
    );
  });

  await test("one editing quote draft per job and version conflict", async () => {
    await expectFail(
      () =>
        admin.query(
          `insert into commercial.document_drafts (
            workspace_id, id, job_id, kind, payload_json, draft_state
          ) values ($1, gen_random_uuid(), $2, 'quote', $3::jsonb, 'editing')`,
          [A.ws, A.job, JSON.stringify({ notes: "", terms: "", expiry_days: 14, lines: [] })],
        ),
      /unique|duplicate/i,
      "second editing quote draft",
    );
    const first = await admin.query(
      "update commercial.document_drafts set payload_json = payload_json, version = version + 1 where id = $1 returning version",
      [A.draft],
    );
    assert(first.rows[0].version === 2, "draft version should increment");
    await admin.query(
      "update commercial.assets set draft_id = $1 where id = $2",
      [A.draft, A.asset],
    );
    const linked = await admin.query("select draft_id from commercial.assets where id = $1", [A.asset]);
    assert(linked.rows[0].draft_id === A.draft, "same-tenant asset draft_id FK should succeed");
  });

  await test("issued documents and lines are immutable", async () => {
    await expectFail(
      () => admin.query("update commercial.documents set total_cents = 1 where id = $1", [A.doc]),
      /immutable/i,
      "update issued document",
    );
    await expectFail(
      () => admin.query("delete from commercial.documents where id = $1", [A.doc]),
      /cannot be deleted|immutable/i,
      "delete issued document",
    );
    await expectFail(
      () =>
        withApi(admin, async () => {
          await admin.query("select identity.set_local_tenant_context($1, $2)", [A.ws, A.user]);
          await admin.query(
            `insert into commercial.documents (
              workspace_id, id, created_by, job_id, kind, number, revision_no, lifecycle,
              issued_at, issue_date, currency, net_cents, tax_cents, total_cents,
              snapshot_json, canonical_snapshot_bytes, schema_version, snapshot_sha256
            ) values ($1, gen_random_uuid(), $2, $3, 'quote', 'Q-000002', 1, 'issued', now(), current_date, 'USD', 0, 0, 0, '{}'::jsonb, $4::bytea, 1, $5)`,
            [A.ws, A.user, A.job, Buffer.from("{}"), "cd".repeat(32)],
          );
        }),
      /permission denied/i,
      "api_app insert documents",
    );
  });

  await test("missing tenant context denies access", async () => {
    const rows = await withApi(admin, async () => {
      const ws = await admin.query("select id from commercial.workspaces");
      const assets = await admin.query("select id from commercial.assets");
      return { ws, assets };
    });
    assert(rows.ws.rows.length === 0, "missing GUC must hide workspaces");
    assert(rows.assets.rows.length === 0, "missing GUC must hide assets");
    await expectFail(
      () =>
        withApi(admin, async () => {
          await admin.query(
            `insert into commercial.workspaces (
              workspace_id, id, owner_user_id, business_name, legal_name, contact_name,
              contact_email, timezone, trade, default_terms
            ) values ($1, $1, $2, 'x', 'x', 'x', 'x@x.x', 'UTC', 'other', 'x')`,
            ["33333333-3333-4333-8333-333333333333", A.user],
          );
        }),
      /row-level security/i,
      "insert without context",
    );
  });

  await test("transaction completion clears tenant context", async () => {
    await withApi(admin, async () => {
      await admin.query("select identity.set_local_tenant_context($1, $2)", [A.ws, A.user]);
    });
    const guc = await admin.query(
      "select current_setting('app.workspace_id', true) as workspace_id, current_setting('app.actor_id', true) as actor_id",
    );
    assert(!guc.rows[0].workspace_id, "workspace GUC must be empty after commit");
    assert(!guc.rows[0].actor_id, "actor GUC must be empty after commit");
  });

  await test("reused pooled connections do not leak previous tenant state", async () => {
    const pool = new Pool({ connectionString: url, max: 1 });
    try {
      const first = await pool.connect();
      try {
        await first.query("begin");
        await first.query("set role api_app");
        await first.query("select identity.set_local_tenant_context($1, $2)", [A.ws, A.user]);
        const seen = await first.query("select id from commercial.workspaces");
        assert(seen.rows.length === 1, "pool borrower should see tenant A in-tx");
        await first.query("reset role");
        await first.query("commit");
      } finally {
        first.release();
      }
      const second = await pool.connect();
      try {
        const leaked = await second.query(
          "select current_setting('app.workspace_id', true) as workspace_id, current_setting('app.actor_id', true) as actor_id",
        );
        assert(!leaked.rows[0].workspace_id, "pooled connection leaked workspace_id");
        assert(!leaked.rows[0].actor_id, "pooled connection leaked actor_id");
        await second.query("begin");
        await second.query("set role api_app");
        const hidden = await second.query("select id from commercial.workspaces");
        assert(hidden.rows.length === 0, "next borrower must not inherit tenant rows");
        await second.query("reset role");
        await second.query("commit");
      } finally {
        second.release();
      }
    } finally {
      await pool.end();
    }
  });

  await test("runtime API role cannot disable or bypass RLS", async () => {
    await expectFail(
      () =>
        withApi(admin, async () => {
          await admin.query("alter table commercial.workspaces disable row level security");
        }),
      /permission denied|must be owner/i,
      "disable RLS",
    );
    await expectFail(
      () =>
        withApi(admin, async () => {
          await admin.query("set row_security = off");
          await admin.query("select id from commercial.workspaces");
        }),
      /row-level security/i,
      "row_security off",
    );
  });

  await test("direct anonymous or authenticated roles cannot access commercial tables", async () => {
    await expectFail(
      async () => {
        await admin.query("set role anon");
        try {
          await admin.query("select id from commercial.workspaces");
        } finally {
          await admin.query("reset role");
        }
      },
      /permission denied/i,
      "anon select",
    );
    await expectFail(
      async () => {
        await admin.query("set role anon");
        try {
          await admin.query("select id from identity.app_users");
        } finally {
          await admin.query("reset role");
        }
      },
      /permission denied/i,
      "anon identity select",
    );
    await expectFail(
      async () => {
        await admin.query("set role authenticated");
        try {
          await admin.query("select id from commercial.memberships");
        } finally {
          await admin.query("reset role");
        }
      },
      /permission denied/i,
      "authenticated select",
    );
    await expectFail(
      async () => {
        await admin.query("set role anon");
        try {
          await admin.query("select id from commercial.jobs");
        } finally {
          await admin.query("reset role");
        }
      },
      /permission denied/i,
      "anon jobs select",
    );
    await expectFail(
      async () => {
        await admin.query("set role anon");
        try {
          await admin.query("select id from commercial.document_drafts");
        } finally {
          await admin.query("reset role");
        }
      },
      /permission denied/i,
      "anon document_drafts select",
    );
    await expectFail(
      async () => {
        await admin.query("set role anon");
        try {
          await admin.query("select id from commercial.documents");
        } finally {
          await admin.query("reset role");
        }
      },
      /permission denied/i,
      "anon documents select",
    );
    await expectFail(
      async () => {
        await admin.query("set role authenticated");
        try {
          await admin.query("select id from commercial.customers");
        } finally {
          await admin.query("reset role");
        }
      },
      /permission denied/i,
      "authenticated customers select",
    );
    await expectFail(
      async () => {
        await admin.query("set role worker_app");
        try {
          await admin.query("select id from commercial.workspaces");
        } finally {
          await admin.query("reset role");
        }
      },
      /permission denied/i,
      "worker_app select",
    );
    await expectFail(
      async () => {
        await admin.query("set role purge_app");
        try {
          await admin.query("select id from identity.app_users");
        } finally {
          await admin.query("reset role");
        }
      },
      /permission denied/i,
      "purge_app select",
    );
  });

  await test("duplicate provisioning is idempotent and creates one workspace", async () => {
    const authId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await admin.query("begin");
    await admin.query("set local role api_app");
    const first = await admin.query(
      `select actor_id, workspace_id, first_sign_in from identity.provision_owner($1, $2, $3)`,
      [authId, "Owner.C@Example.com", "owner.c@example.com"],
    );
    const second = await admin.query(
      `select actor_id, workspace_id, first_sign_in from identity.provision_owner($1, $2, $3)`,
      [authId, "Owner.C@Example.com", "owner.c@example.com"],
    );
    await admin.query("commit");
    assert(first.rows[0]?.actor_id === second.rows[0]?.actor_id, "actor must be stable");
    assert(first.rows[0]?.workspace_id === second.rows[0]?.workspace_id, "workspace must be stable");
    assert(first.rows[0]?.first_sign_in === true, "first call is first sign-in");
    assert(second.rows[0]?.first_sign_in === false, "retry is not first sign-in");
    const workspaces = await admin.query(
      "select count(*)::int as n from commercial.workspaces where owner_user_id = $1",
      [first.rows[0]?.actor_id],
    );
    assert(workspaces.rows[0]?.n === 1, "exactly one workspace");
    const owners = await admin.query(
      "select count(*)::int as n from commercial.memberships where workspace_id = $1 and role = 'owner' and status = 'active'",
      [first.rows[0]?.workspace_id],
    );
    assert(owners.rows[0]?.n === 1, "exactly one active owner");
  });

  await test("provisioned owner cannot read another identity without tenant context", async () => {
    const rows = await withApi(admin, async () => {
      const users = await admin.query("select id from identity.app_users");
      return users.rows;
    });
    assert(rows.length === 0, "missing GUC must hide app_users");
  });

  const setupAuth = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const otherAuth = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const setupKey = "77777777-7777-4777-8777-777777777777";
  const setupHash = "a".repeat(64);
  const setupRequest = "88888888-8888-4888-8888-888888888888";

  async function provision(authId, email) {
    await admin.query("begin");
    try {
      await admin.query("set local role api_app");
      const row = await admin.query(
        `select actor_id, workspace_id, workspace_version from identity.provision_owner($1, $2, $3)`,
        [authId, email, email.toLowerCase()],
      );
      await admin.query("commit");
      return row.rows[0];
    } catch (error) {
      try {
        await admin.query("rollback");
      } catch {
        /* already aborted */
      }
      throw error;
    }
  }

  async function completeSetup(actorId, version, key, hash, requestId, name = "Setup Biz") {
    await admin.query("begin");
    try {
      await admin.query("set local role api_app");
      const row = await admin.query(
        `select actor_id, workspace_id, setup_completed, workspace_version, replayed
         from commercial.complete_workspace_setup(
           $1::uuid, $2::integer, $3::uuid, $4, $5::uuid,
           $6, $6, 'Owner Name', 'owner@example.com', null,
           $7::jsonb, 'America/New_York', 'handyman', 0, 14, 'Net 14'
         )`,
        [
          actorId,
          version,
          key,
          hash,
          requestId,
          name,
          JSON.stringify({ line1: "1 Main St", city: "Miami", state: "FL", postal_code: "33101" }),
        ],
      );
      await admin.query("commit");
      return row.rows[0];
    } catch (error) {
      try {
        await admin.query("rollback");
      } catch {
        /* already aborted */
      }
      throw error;
    }
  }

  await test("owner completes their workspace and increments version once", async () => {
    const owner = await provision(setupAuth, "setup.e@example.com");
    const first = await completeSetup(owner.actor_id, owner.workspace_version, setupKey, setupHash, setupRequest);
    assert(first.setup_completed === true, "setup should complete");
    assert(first.workspace_version === owner.workspace_version + 1, "version should increment");
    assert(first.replayed === false, "first complete is not a replay");
    const replay = await completeSetup(owner.actor_id, owner.workspace_version, setupKey, setupHash, setupRequest);
    assert(replay.replayed === true, "same key should replay");
    assert(replay.workspace_version === first.workspace_version, "replay must not increment again");
    const audit = await admin.query(
      "select count(*)::int as n from commercial.audit_events where entity_id = $1 and action = 'workspace_setup_completed'",
      [owner.workspace_id],
    );
    assert(audit.rows[0].n === 1, "one audit event");
    const completedAt = await admin.query(
      "select setup_completed_at, currency from commercial.workspaces where id = $1",
      [owner.workspace_id],
    );
    assert(completedAt.rows[0].setup_completed_at, "server assigns setup_completed_at");
    assert(completedAt.rows[0].currency === "USD", "currency remains USD");
  });

  await test("idempotency key mismatch and stale versions fail", async () => {
    const owner = await provision(setupAuth, "setup.e@example.com");
    await expectFail(
      () => completeSetup(owner.actor_id, owner.workspace_version, setupKey, "b".repeat(64), setupRequest),
      /IDEMPOTENCY_MISMATCH/i,
      "idempotency mismatch",
    );
    await expectFail(
      () =>
        completeSetup(
          owner.actor_id,
          99,
          "99999999-9999-4999-8999-999999999999",
          "c".repeat(64),
          "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        ),
      /VERSION_CONFLICT/i,
      "stale version",
    );
  });

  await test("owner cannot complete another workspace and forged ids do not grant access", async () => {
    const owner = await provision(setupAuth, "setup.e@example.com");
    const other = await provision(otherAuth, "setup.f@example.com");
    const otherBefore = await admin.query(
      "select business_name, setup_completed_at from commercial.workspaces where id = $1",
      [other.workspace_id],
    );
    await withApi(admin, async () => {
      await admin.query("select identity.set_local_tenant_context($1, $2)", [owner.workspace_id, owner.actor_id]);
      const updated = await admin.query("update commercial.workspaces set business_name = 'hijack' where id = $1", [
        other.workspace_id,
      ]);
      assert(updated.rowCount === 0, "owner must not update another workspace");
    });
    const otherAfter = await admin.query(
      "select business_name, setup_completed_at from commercial.workspaces where id = $1",
      [other.workspace_id],
    );
    assert(otherAfter.rows[0].business_name === otherBefore.rows[0].business_name, "other workspace name unchanged");
    assert(
      otherAfter.rows[0].setup_completed_at === otherBefore.rows[0].setup_completed_at,
      "other workspace setup unchanged",
    );
  });

  await test("invalid currency and client-assigned setup_completed_at are rejected", async () => {
    await expectFail(
      () => admin.query("update commercial.workspaces set currency = 'EUR' where id = $1", [A.ws]),
      /USD|currency/i,
      "non-USD currency",
    );
    await expectFail(
      () =>
        withApi(admin, async () => {
          await admin.query("select identity.set_local_tenant_context($1, $2)", [A.ws, A.user]);
          await admin.query("update commercial.workspaces set setup_completed_at = now() where id = $1", [A.ws]);
        }),
      /server-assigned|setup_completed_at/i,
      "client setup_completed_at",
    );
  });

  await test("invalid tax and due-day values fail", async () => {
    await expectFail(
      () => admin.query("update commercial.workspaces set default_tax_bp = 2501 where id = $1", [A.ws]),
      /check|tax/i,
      "tax over 2500bp",
    );
    await expectFail(
      () => admin.query("update commercial.workspaces set default_due_days = 366 where id = $1", [A.ws]),
      /check|due/i,
      "due days over 365",
    );
  });

  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
} finally {
  await admin.end();
  await stop();
}
