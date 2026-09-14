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
};
const B = {
  user: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  auth: "bbbb1111-bbbb-4111-8bbb-bbbbbbbbbbbb",
  ws: "22222222-2222-4222-8222-222222222222",
  mem: "bbbb2222-bbbb-4222-8222-bbbbbbbbbbbb",
  asset: "bbbb3333-bbbb-4333-8333-bbbbbbbbbbbb",
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
  await applyCleanMigrations(admin, root);
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
    });
  }

  await test("roles are distinct and api/worker/purge cannot bypass RLS", async () => {
    const roles = await admin.query(`
      select rolname, rolsuper, rolbypassrls, rolcanlogin
      from pg_roles
      where rolname in ('migrator', 'api_app', 'worker_app', 'purge_app')
      order by rolname
    `);
    const byName = Object.fromEntries(roles.rows.map((row) => [row.rolname, row]));
    assert(byName.api_app.rolsuper === false, "api_app must not be superuser");
    assert(byName.api_app.rolbypassrls === false, "api_app must not bypass RLS");
    assert(byName.api_app.rolcanlogin === false, "api_app must be nologin");
    assert(byName.worker_app.rolsuper === false, "worker_app must not be superuser");
    assert(byName.worker_app.rolbypassrls === false, "worker_app must not bypass RLS");
    assert(byName.purge_app.rolbypassrls === false, "purge_app must not bypass RLS");
    assert(byName.migrator.rolbypassrls === true, "migrator may bypass RLS for migrations");
    assert(byName.api_app !== byName.worker_app, "roles must be distinct");
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
  });

  await insertUser(admin, A, "a@example.com");
  await insertUser(admin, B, "b@example.com");
  await insertWorkspace(admin, A);
  await insertWorkspace(admin, B);

  await test("workspace A can read its own records", async () => {
    const rows = await withApi(admin, async () => {
      await admin.query("select identity.set_local_tenant_context($1, $2)", [A.ws, A.user]);
      const ws = await admin.query("select id from commercial.workspaces");
      const mem = await admin.query("select user_id from commercial.memberships");
      const assets = await admin.query("select id from commercial.assets");
      const me = await admin.query("select id from identity.app_users");
      return { ws, mem, assets, me };
    });
    assert(rows.ws.rows.length === 1 && rows.ws.rows[0].id === A.ws, "A should see own workspace");
    assert(rows.mem.rows.length === 1 && rows.mem.rows[0].user_id === A.user, "A should see own membership");
    assert(rows.assets.rows.length === 1 && rows.assets.rows[0].id === A.asset, "A should see own asset");
    assert(rows.me.rows.length === 1 && rows.me.rows[0].id === A.user, "A should see own app_user");
  });

  await test("workspace A cannot read workspace B", async () => {
    const rows = await withApi(admin, async () => {
      await admin.query("select identity.set_local_tenant_context($1, $2)", [A.ws, A.user]);
      const ws = await admin.query("select id from commercial.workspaces where id = $1", [B.ws]);
      const assets = await admin.query("select id from commercial.assets where id = $1", [B.asset]);
      const users = await admin.query("select id from identity.app_users where id = $1", [B.user]);
      return { ws, assets, users };
    });
    assert(rows.ws.rows.length === 0, "A must not see B workspace");
    assert(rows.assets.rows.length === 0, "A must not see B asset");
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
    const still = await admin.query("select business_name from commercial.workspaces where id = $1", [B.ws]);
    assert(still.rows[0].business_name.startsWith("Biz"), "B workspace must be unchanged");
  });

  await test("a forged workspace_id does not grant access", async () => {
    const rows = await withApi(admin, async () => {
      await admin.query("select identity.set_local_tenant_context($1, $2)", [B.ws, A.user]);
      const ws = await admin.query("select id from commercial.workspaces");
      const assets = await admin.query("select id from commercial.assets");
      return { ws, assets };
    });
    assert(rows.ws.rows.length === 0, "forged GUC must not reveal B workspace");
    assert(rows.assets.rows.length === 0, "forged GUC must not reveal B assets");
  });

  await test("a cross-tenant foreign-key reference fails", async () => {
    await expectFail(
      () =>
        admin.query("update commercial.workspaces set logo_asset_id = $1 where id = $2", [B.asset, A.ws]),
      /foreign key/i,
      "cross-tenant logo_asset_id",
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

  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
} finally {
  await admin.end();
  await stop();
}
