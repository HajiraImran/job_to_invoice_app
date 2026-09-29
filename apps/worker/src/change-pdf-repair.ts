// Targeted change-order PDF repair for one dead generate_original_pdf task.
//   inspect (default): READ ONLY. Lists CO-000001 R1 change documents with their
//     approval request, PDF task, artifacts, EMAIL02 send task, and delivery state,
//     plus the Q-000001 PDF task. Prints no secrets, emails, tokens, or names.
//   --requeue --workspace <uuid> --document <uuid> --task <uuid>:
//     one transaction that re-arms exactly that dead task after guarding kind,
//     number, revision, request state, email state, and the 0029 claim fix.
//   --verify --workspace <uuid> --document <uuid>:
//     READ ONLY artifact/object check, then the review page state from
//     get_portal_document inside a transaction that is always rolled back.
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { networkInterfaces } from "node:os";
import pg from "pg";
import { alignDevelopmentStorageEnv, loadApiEnv, loadWorkerEnv, workerClientOptions } from "@job-to-invoice/config";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const index = args.indexOf(`--${name}`);
  const found = index >= 0 ? args[index + 1] : undefined;
  return found && UUID.test(found) ? found : undefined;
};

alignDevelopmentStorageEnv(process.env, {
  localAddresses: Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4")
    .map((entry) => entry.address),
});
const env = loadWorkerEnv();
if (!env.DATABASE_URL_WORKER) {
  throw new Error("DATABASE_URL_WORKER is not configured");
}
const sqlstate = (error: unknown) => (error as { code?: unknown }).code ?? "unknown";

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 30_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function inspect(client: pg.Client) {
  await client.query("begin read only");
  try {
    await client.query("set local statement_timeout = 15000");
    const who = await client.query(`
      select current_user as login,
             has_table_privilege('commercial.outbox_tasks', 'UPDATE') as can_update_tasks,
             exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'commercial' and p.proname = 'claim_generate_original_pdf'
                       and p.prosrc like '%''credit'', ''change''%') as claim_accepts_change`);
    const history = await client.query(`
      select
        exists (select 1 from supabase_migrations.schema_migrations where version = '0028') as recorded_0028,
        exists (select 1 from supabase_migrations.schema_migrations where version = '0029') as recorded_0029,
        (select max(version) from supabase_migrations.schema_migrations) as latest`);
    const changes = await client.query(`
      select d.workspace_id, d.id as document_id, d.number, d.revision_no, d.lifecycle, d.created_at,
             r.id as request_id, r.state as request_state, r.purpose, r.expires_at, r.expires_at > now() as request_live,
             (select coalesce(jsonb_agg(jsonb_build_object(
                'task_id', o.id, 'status', o.status, 'attempts', o.attempts, 'last_error', o.last_error_code,
                'artifact_reserved', o.payload_json ? 'artifact_id', 'created_at', o.created_at) order by o.created_at), '[]')
                from commercial.outbox_tasks o
               where o.workspace_id = d.workspace_id and o.aggregate_id = d.id and o.task_type = 'generate_original_pdf') as pdf_tasks,
             (select count(*)::int from commercial.artifacts a
               where a.workspace_id = d.workspace_id and a.document_id = d.id and a.type = 'original_pdf') as original_artifacts,
             (select coalesce(jsonb_agg(jsonb_build_object(
                'task_id', o.id, 'status', o.status, 'attempts', o.attempts, 'last_error', o.last_error_code,
                'template', o.payload_json->>'template_id') order by o.created_at), '[]')
                from commercial.outbox_tasks o
               where o.workspace_id = d.workspace_id and o.aggregate_id = r.id and o.task_type = 'send_email') as email_tasks,
             (select coalesce(jsonb_agg(jsonb_build_object(
                'template', a.template_id, 'state', a.state, 'retry_count', a.retry_count, 'last_event_at', a.last_event_at)
                order by a.created_at), '[]')
                from commercial.delivery_attempts a
               where a.workspace_id = d.workspace_id and a.request_id = r.id) as deliveries,
             (select count(*)::int from commercial.approval_sessions s
               where s.workspace_id = d.workspace_id and s.request_id = r.id
                 and s.revoked_at is null and s.expires_at > now() and s.token_generation >= 1) as active_review_sessions,
             (select max(s.created_at) from commercial.approval_sessions s
               where s.workspace_id = d.workspace_id and s.request_id = r.id) as last_review_session_at
      from commercial.documents d
      left join lateral (
        select * from commercial.approval_requests ar
        where ar.workspace_id = d.workspace_id and ar.document_id = d.id
        order by ar.created_at desc limit 1
      ) r on true
      where d.kind = 'change' and d.number = 'CO-000001' and d.revision_no = 1
      order by d.created_at desc`);
    const quote = await client.query(`
      select o.id as task_id, o.workspace_id, o.aggregate_id as document_id, o.status, o.attempts,
             o.last_error_code, o.payload_json ? 'artifact_id' as artifact_reserved, o.created_at,
             (select count(*)::int from commercial.artifacts a
               where a.workspace_id = o.workspace_id and a.document_id = o.aggregate_id and a.type = 'original_pdf') as original_artifacts
      from commercial.outbox_tasks o
      join commercial.documents d on d.workspace_id = o.workspace_id and d.id = o.aggregate_id
      where o.task_type = 'generate_original_pdf' and d.kind = 'quote' and d.number = 'Q-000001' and o.status <> 'done'
      order by o.created_at desc`);
    return { privileges: who.rows[0], history: history.rows[0], changeOrders: changes.rows, q000001: quote.rows };
  } finally {
    await client.query("rollback").catch(() => undefined);
  }
}

async function requeue(client: pg.Client, ids: { workspace: string; document: string; task: string }) {
  await client.query("begin");
  try {
    await client.query("set local statement_timeout = 15000");
    const fixed = await client.query<{ ok: boolean }>(`
      select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'commercial' and p.proname = 'claim_generate_original_pdf'
                       and p.prosrc like '%''credit'', ''change''%') as ok`);
    if (!fixed.rows[0]?.ok) {
      throw Object.assign(new Error("migration 0029 is not applied"), { code: "NOT_MIGRATED" });
    }
    const guarded = await client.query<{ ok: boolean; reason: string }>(
      `select
         case
           when d.id is null then 'document_not_change_co000001_r1'
           when t.id is null then 'task_not_dead_pdf_task_for_document'
           when exists (select 1 from commercial.artifacts a
                        where a.workspace_id = d.workspace_id and a.document_id = d.id and a.type = 'original_pdf')
             then 'artifact_already_exists'
           when (select count(*) from commercial.outbox_tasks o
                 where o.workspace_id = d.workspace_id and o.aggregate_id = d.id
                   and o.task_type = 'generate_original_pdf') <> 1 then 'multiple_pdf_tasks'
           when r.id is null or r.state <> 'pending' or r.purpose <> 'approval' or r.expires_at <= now()
             then 'request_not_pending'
           when exists (select 1 from commercial.outbox_tasks o
                        where o.workspace_id = d.workspace_id and o.aggregate_id = r.id
                          and o.task_type = 'send_email' and o.status in ('pending', 'running'))
             then 'email_task_still_claimable'
           else 'ok'
         end as reason
       from (select 1) s
       left join commercial.documents d
         on d.workspace_id = $1 and d.id = $2 and d.kind = 'change' and d.number = 'CO-000001' and d.revision_no = 1
       left join commercial.outbox_tasks t
         on t.workspace_id = $1 and t.id = $3 and t.aggregate_id = $2
        and t.task_type = 'generate_original_pdf' and t.status = 'dead'
       left join lateral (
         select * from commercial.approval_requests ar
         where ar.workspace_id = $1 and ar.document_id = $2 order by ar.created_at desc limit 1
       ) r on true`,
      [ids.workspace, ids.document, ids.task],
    );
    const reason = guarded.rows[0]?.reason ?? "no_row";
    if (reason !== "ok") {
      await client.query("rollback");
      return { requeued: false, reason };
    }
    await client.query("select 1 from commercial.outbox_tasks where id = $1 for update", [ids.task]);
    const updated = await client.query<{ status: string; attempts: number }>(
      `update commercial.outbox_tasks
          set status = 'pending', attempts = 0, last_error_code = null, lease_until = null, available_at = now()
        where workspace_id = $1 and id = $2 and aggregate_id = $3
          and task_type = 'generate_original_pdf' and status = 'dead'
        returning status, attempts`,
      [ids.workspace, ids.task, ids.document],
    );
    if (updated.rowCount !== 1) {
      await client.query("rollback");
      return { requeued: false, reason: `updated_${updated.rowCount ?? 0}_rows` };
    }
    await client.query("commit");
    return { requeued: true, task: updated.rows[0] };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    return { requeued: false, reason: (error as { code?: string }).code === "NOT_MIGRATED" ? "not_migrated" : `sqlstate_${String(sqlstate(error))}` };
  }
}

async function verify(ids: { workspace: string; document: string }) {
  const out: Record<string, unknown> = {};
  let requestId: string | undefined;
  await withClient(env.DATABASE_URL_WORKER as string, async (client) => {
    await client.query("begin read only");
    try {
      const task = await client.query(
        `select status, attempts, last_error_code from commercial.outbox_tasks
          where workspace_id = $1 and aggregate_id = $2 and task_type = 'generate_original_pdf'`,
        [ids.workspace, ids.document],
      );
      const artifacts = await client.query<{ object_key: string; state: string; template_version: string; bytes: string }>(
        `select object_key, state, template_version, bytes::text from commercial.artifacts
          where workspace_id = $1 and document_id = $2 and type = 'original_pdf'`,
        [ids.workspace, ids.document],
      );
      const request = await client.query<{ id: string; state: string; purpose: string; live: boolean }>(
        `select id, state, purpose, expires_at > now() as live from commercial.approval_requests
          where workspace_id = $1 and document_id = $2 order by created_at desc limit 1`,
        [ids.workspace, ids.document],
      );
      requestId = request.rows[0]?.id;
      const emails = requestId
        ? await client.query(
            `select o.status, o.attempts, o.payload_json->>'template_id' as template,
                    (select count(*)::int from commercial.delivery_attempts a where a.request_id = $1) as deliveries
               from commercial.outbox_tasks o where o.aggregate_id = $1 and o.task_type = 'send_email'`,
            [requestId],
          )
        : { rows: [] };
      out.pdfTasks = task.rows;
      out.originalArtifacts = artifacts.rows.map((a) => ({ state: a.state, template: a.template_version, bytes: a.bytes }));
      out.request = request.rows[0] ? { state: request.rows[0].state, purpose: request.rows[0].purpose, live: request.rows[0].live } : null;
      out.emailTasks = emails.rows;
      const artifact = artifacts.rows[0];
      if (artifact && env.documentsStorage) {
        const s3 = new S3Client({ ...workerClientOptions(env.documentsStorage), maxAttempts: 1 });
        try {
          const got = await s3.send(new GetObjectCommand({ Bucket: env.documentsStorage.bucket, Key: artifact.object_key }), {
            abortSignal: AbortSignal.timeout(12_000),
          });
          const bytes = Buffer.from((await got.Body?.transformToByteArray()) ?? []);
          out.object = { present: true, isPdf: bytes.subarray(0, 5).toString("latin1") === "%PDF-", bytesMatch: String(bytes.byteLength) === artifact.bytes };
        } catch (error) {
          out.object = { present: false, code: (error as { name?: string }).name };
        } finally {
          s3.destroy();
        }
      }
    } finally {
      await client.query("rollback").catch(() => undefined);
    }
  });
  const apiUrl = loadApiEnv().DATABASE_URL_API;
  if (!apiUrl || !requestId) {
    out.reviewPage = apiUrl ? "no_request" : "api_database_url_missing";
    return out;
  }
  await withClient(apiUrl, async (client) => {
    await client.query("begin");
    try {
      await client.query("set local statement_timeout = 15000");
      const sessions = await client.query<{ session_hash: string }>(
        `select session_hash from commercial.approval_sessions
          where request_id = $1 and revoked_at is null and expires_at > now() and token_generation >= 1
          order by created_at desc limit 1`,
        [requestId],
      );
      const hash = sessions.rows[0]?.session_hash;
      await client.query("set local role api_app");
      if (hash) {
        const page = await client.query<{
          access_state: string;
          pdf_state: string;
          allowed_actions: string[];
          number: string;
          revision_no: number;
        }>("select access_state, pdf_state, allowed_actions, number, revision_no from commercial.get_portal_document($1)", [
          hash,
        ]);
        out.reviewPage = page.rows[0] ?? "no_row";
        return;
      }
      const download = await client.query<{ download_state: string }>(
        "select download_state from commercial.original_pdf_download($1::uuid, $2::uuid)",
        [ids.workspace, ids.document],
      );
      const req = out.request as { state?: string; purpose?: string; live?: boolean } | null;
      const pdfState = download.rows[0]?.download_state ?? "unknown";
      const actions = ["report"];
      if ((req?.state === "pending" || req?.state === "decided") && pdfState === "ready") {
        actions.push("download");
      }
      if (req?.state === "pending" && req.purpose === "approval" && pdfState === "ready") {
        actions.push("approve", "decline");
      }
      out.reviewPage = {
        session: "expired_or_absent",
        access_state: req?.live && req.state === "pending" ? "pending" : req?.state,
        pdf_state: pdfState,
        allowed_actions: actions,
        decided: false,
      };
    } catch (error) {
      out.reviewPage = { error: `sqlstate_${String(sqlstate(error))}` };
    } finally {
      await client.query("rollback").catch(() => undefined);
    }
  });
  return out;
}

const workspace = value("workspace");
const document = value("document");
const task = value("task");
let result: unknown;
if (flag("requeue")) {
  if (!workspace || !document || !task) {
    throw new Error("--requeue needs --workspace, --document, and --task UUIDs");
  }
  result = await withClient(env.DATABASE_URL_WORKER, (client) => requeue(client, { workspace, document, task }));
} else if (flag("verify")) {
  if (!workspace || !document) {
    throw new Error("--verify needs --workspace and --document UUIDs");
  }
  result = await verify({ workspace, document });
} else {
  result = await withClient(env.DATABASE_URL_WORKER, inspect);
}
console.log(JSON.stringify(result, null, 2));
