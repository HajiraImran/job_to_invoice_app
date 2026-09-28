// Read-only PDF pipeline diagnostic. Prints only safe fields: no secrets,
// connection strings, customer data, or full tenant identifiers.
// Storage writes are limited to one isolated diagnostics/ object that is
// deleted again. Database access runs in a READ ONLY transaction.
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import { networkInterfaces } from "node:os";
import { alignDevelopmentStorageEnv, loadWorkerEnv, workerClientOptions } from "@job-to-invoice/config";
import { originalPdfObjectKey } from "@job-to-invoice/domain";

const short = (id: unknown) => (typeof id === "string" ? `${id.slice(0, 8)}…` : null);

function errorSummary(error: unknown): Record<string, unknown> {
  const e = error as {
    name?: unknown;
    code?: unknown;
    errno?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
    cause?: { code?: unknown };
  };
  return {
    name: typeof e?.name === "string" ? e.name : undefined,
    code: typeof e?.code === "string" ? e.code : typeof e?.Code === "string" ? e.Code : undefined,
    causeCode: typeof e?.cause?.code === "string" ? e.cause.code : undefined,
    httpStatus: e?.$metadata?.httpStatusCode,
  };
}

function tcpProbe(host: string, port: number, family: number): Promise<Record<string, unknown>> {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = connect({ host, port, family, timeout: 3000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve({ ok: true, ms: Date.now() - started });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ ok: false, code: "ETIMEDOUT", ms: Date.now() - started });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      resolve({ ok: false, code: error.code, ms: Date.now() - started });
    });
  });
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: Record<string, unknown> }> {
  const started = Date.now();
  try {
    const value = await fn();
    return { ms: Date.now() - started, value };
  } catch (error) {
    return { ms: Date.now() - started, error: errorSummary(error) };
  }
}

const aligned = alignDevelopmentStorageEnv(process.env, {
  localAddresses: Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4")
    .map((entry) => entry.address),
});
const env = loadWorkerEnv();
const storage = env.documentsStorage;
const out: Record<string, unknown> = { appEnv: env.APP_ENV, aligned };

if (!storage) {
  out.storage = "missing";
} else {
  const url = new URL(storage.endpoint);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const hostKind = ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(hostname.toLowerCase())
    ? "loopback"
    : /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)
      ? "rfc1918"
      : "other";
  out.storage = {
    scheme: url.protocol.replace(":", ""),
    hostKind,
    hostIsLiteralIp: /^[\d.]+$|:/.test(hostname),
    port,
    bucket: storage.bucket,
    region: storage.region,
    forcePathStyle: storage.forcePathStyle,
    workerCredentialsPresent: Boolean(storage.worker.accessKeyId && storage.worker.secretAccessKey),
    downloadEndpointConfigured: Boolean(storage.downloadEndpoint),
  };
  const addresses = await lookup(hostname, { all: true }).catch((error: unknown) => {
    out.dns = errorSummary(error);
    return [];
  });
  const first = await lookup(hostname).catch(() => undefined);
  out.dnsFirstFamily = first?.family;
  out.tcp = await Promise.all(
    addresses.map(async (a) => ({ family: a.family, kind: hostKind, ...(await tcpProbe(a.address, port, a.family)) })),
  );

  const client = new S3Client({
    ...workerClientOptions(storage),
    requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 },
    maxAttempts: 1,
  });
  const key = `diagnostics/storage-check/${randomUUID()}.pdf`;
  const body = Buffer.from("%PDF-1.4\n% storage diagnostic fixture\n%%EOF\n");
  const put = await timed(() =>
    client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: body, ContentType: "application/pdf" }), {
      abortSignal: AbortSignal.timeout(12000),
    }),
  );
  const get = put.error
    ? undefined
    : await timed(async () => {
        const result = await client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }), {
          abortSignal: AbortSignal.timeout(12000),
        });
        const bytes = Buffer.from((await result.Body?.transformToByteArray()) ?? []);
        return createHash("sha256").update(bytes).digest("hex") === createHash("sha256").update(body).digest("hex");
      });
  const anonymous = put.error
    ? undefined
    : await timed(async () => {
        const base = storage.endpoint.replace(/\/$/, "");
        const res = await fetch(`${base}/${storage.bucket}/${key}`, { signal: AbortSignal.timeout(5000) });
        return res.status;
      });
  const del = put.error
    ? undefined
    : await timed(() =>
        client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }), {
          abortSignal: AbortSignal.timeout(12000),
        }),
      );
  out.s3 = {
    put: { ms: put.ms, ok: !put.error, error: put.error },
    getMatches: get ? { ms: get.ms, value: get.value, error: get.error } : "skipped",
    anonymousGetStatus: anonymous ? (anonymous.value ?? anonymous.error) : "skipped",
    delete: del ? { ms: del.ms, ok: !del.error, error: del.error } : "skipped",
  };
  client.destroy();
}

const databaseUrl = env.DATABASE_URL_WORKER;
if (!databaseUrl) {
  out.database = "missing";
} else {
  const dbUrl = new URL(databaseUrl);
  const dbPort = Number(dbUrl.port || 5432);
  const dbAddresses = await lookup(dbUrl.hostname, { all: true }).catch((error: unknown) => {
    out.databaseDns = errorSummary(error);
    return [];
  });
  out.databaseHost = {
    supabasePooler: dbUrl.hostname.endsWith(".pooler.supabase.com"),
    port: dbPort,
    tcp: await Promise.all(
      dbAddresses.map(async (a) => ({ family: a.family, ...(await tcpProbe(a.address, dbPort, a.family)) })),
    ),
  };
  const hostConnect = async (attemptTimeout?: number) => {
    const started = Date.now();
    return new Promise<Record<string, unknown>>((resolve) => {
      const socket = connect({
        host: dbUrl.hostname,
        port: dbPort,
        autoSelectFamily: true,
        ...(attemptTimeout ? { autoSelectFamilyAttemptTimeout: attemptTimeout } : {}),
      });
      const done = (result: Record<string, unknown>) => {
        socket.destroy();
        resolve({ ms: Date.now() - started, ...result });
      };
      socket.setTimeout(30000, () => done({ ok: false, code: "TIMEOUT_30S" }));
      socket.once("connect", () => done({ ok: true }));
      socket.once("error", (error: NodeJS.ErrnoException) => done({ ok: false, code: error.code ?? error.name }));
    });
  };
  const rounds = Number(process.env.DIAG_DB_CONNECT_ROUNDS ?? 0);
  if (rounds > 0) {
    const { getDefaultAutoSelectFamilyAttemptTimeout } = await import("node:net");
    const byHostname: Record<string, unknown[]> = {};
    for (const timeout of [undefined, 2500]) {
      const label = timeout ? `attempt_${timeout}ms` : `default_${getDefaultAutoSelectFamilyAttemptTimeout()}ms`;
      byHostname[label] = [];
      for (let i = 0; i < rounds; i += 1) {
        byHostname[label].push(await hostConnect(timeout));
      }
    }
    out.databaseConnectByHostname = byHostname;
    console.log(JSON.stringify({ databaseHost: out.databaseHost, databaseConnectByHostname: byHostname }, null, 2));
    process.exit(0);
  }
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 30000 });
  const connected = await timed(() => client.connect());
  out.database = { connectMs: connected.ms, error: connected.error };
  if (!connected.error) {
    const rt = await timed(() => client.query("select 1"));
    (out.database as Record<string, unknown>).roundTripMs = rt.ms;
    try {
      await client.query("begin read only");
      await client.query("set local statement_timeout = 15000");
      const tasks = await client.query(`
        select o.id, o.workspace_id, o.aggregate_id, o.status, o.attempts, o.last_error_code,
               o.created_at, o.available_at, o.lease_until, now() as db_now,
               o.payload_json->>'artifact_id' as artifact_id,
               d.number, d.revision_no, d.kind,
               (select count(*)::int from commercial.artifacts a
                  where a.workspace_id = o.workspace_id and a.document_id = o.aggregate_id
                    and a.type = 'original_pdf') as original_rows,
               (select a.state from commercial.artifacts a
                  where a.workspace_id = o.workspace_id and a.document_id = o.aggregate_id
                    and a.type = 'original_pdf' limit 1) as artifact_state
        from commercial.outbox_tasks o
        left join commercial.documents d on d.workspace_id = o.workspace_id and d.id = o.aggregate_id
        where o.task_type = 'generate_original_pdf'
        order by (o.status = 'done'), o.created_at desc
        limit 6`);
      const locks = await client.query(`
        select count(*) filter (where not granted)::int as waiting_locks,
               count(*)::int as total_locks
        from pg_locks where database = (select oid from pg_database where datname = current_database())`);
      const activity = await client.query(`
        select state, wait_event_type, count(*)::int as n,
               max(extract(epoch from now() - xact_start))::int as oldest_xact_s
        from pg_stat_activity where datname = current_database()
        group by 1, 2 order by 3 desc`);
      await client.query("rollback");
      const rows = [];
      for (const t of tasks.rows) {
        let objectExists: unknown = "unknown";
        if (storage && t.artifact_id && t.revision_no) {
          const key = originalPdfObjectKey({
            workspaceId: t.workspace_id,
            documentId: t.aggregate_id,
            revision: t.revision_no,
            artifactId: t.artifact_id,
          });
          const s3 = new S3Client({
            ...workerClientOptions(storage),
            requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 },
            maxAttempts: 1,
          });
          const got = await timed(() =>
            s3.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }), { abortSignal: AbortSignal.timeout(12000) }),
          );
          objectExists = got.error ? (got.error.code ?? got.error.name) : true;
          s3.destroy();
        }
        rows.push({
          task: short(t.id),
          document: short(t.aggregate_id),
          number: t.number,
          revision: t.revision_no,
          kind: t.kind,
          status: t.status,
          attempts: t.attempts,
          lastError: t.last_error_code,
          createdAt: t.created_at,
          availableInS: Math.round((new Date(t.available_at).getTime() - new Date(t.db_now).getTime()) / 1000),
          leaseRemainingS: t.lease_until
            ? Math.round((new Date(t.lease_until).getTime() - new Date(t.db_now).getTime()) / 1000)
            : null,
          artifactReserved: Boolean(t.artifact_id),
          originalRows: t.original_rows,
          artifactState: t.artifact_state,
          objectExists,
        });
      }
      Object.assign(out.database as Record<string, unknown>, {
        tasks: rows,
        locks: locks.rows[0],
        activity: activity.rows,
      });
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      const e = error as { code?: unknown; message?: unknown };
      (out.database as Record<string, unknown>).queryError = { sqlstate: e.code };
    }
    await client.end().catch(() => undefined);
  }
}

console.log(JSON.stringify(out, null, 2));
