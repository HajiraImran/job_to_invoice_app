import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  isClientUuid,
  parseJobCreate,
  parseJobListQuery,
  parseOwnerEmail,
  type JobListState,
} from "@job-to-invoice/schemas";
import type { Pool } from "pg";
import { quoteDraftSummary } from "./drafts.ts";
import { quoteDocumentSummary } from "./quotes.ts";
import { withApiRole, withTenant } from "./db.ts";
import { API_ERROR_CODES, fail, success } from "./envelope.ts";
import { bearerToken, JwtVerificationError, type JwtVerifier, type VerifiedAccess } from "./jwt.ts";

const GENERIC_AUTH = "Could not verify your session.";
const SIGN_IN_REQUIRED = "Sign in required.";
const JOB_NOT_FOUND = "Job was not found.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ProvisionRow = {
  actor_id: string;
  workspace_id: string;
  account_status: string;
  display_email: string;
  setup_completed: boolean;
  first_sign_in: boolean;
  analytics_alias_id: string;
  workspace_version: number;
};

type JobRow = {
  id: string;
  workspace_id: string;
  customer_id: string;
  customer_name: string;
  title: string;
  site_address_json: unknown;
  no_site: boolean;
  lifecycle: string;
  mode: string;
  internal_notes: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  quote_draft_id?: string | null;
  quote_draft_version?: number | null;
  quote_draft_payload?: unknown;
  current_quote_id?: string | null;
  current_quote_number?: string | null;
  current_quote_revision?: number | null;
  current_quote_lifecycle?: string | null;
  current_quote_total?: string | number | null;
  replayed?: boolean;
};

type JobListRow = {
  id: string;
  customer_id: string;
  customer_name: string;
  title: string;
  lifecycle: string;
  mode: string;
  no_site: boolean;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type JobCursor = { u: string; i: string; s: string | null; t: JobListState };

function sendFail(
  request: FastifyRequest,
  reply: FastifyReply,
  code: string,
  message: string,
  extra?: { field_errors?: { field: string; message: string }[] },
) {
  const result = fail(request.id, code, message, { field_errors: extra?.field_errors });
  return reply.status(result.status).send(result.body);
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const raw = request.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

function requestHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function pgCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

function asIso(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(value).toISOString();
}

function firstQuery(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

export function encodeJobCursor(payload: JobCursor): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeJobCursor(raw: string): JobCursor | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.u !== "string" || !isClientUuid(record.i)) {
      return undefined;
    }
    if (record.s !== null && typeof record.s !== "string") {
      return undefined;
    }
    if (record.t !== "open" && record.t !== "finished" && record.t !== "archived") {
      return undefined;
    }
    return { u: record.u, i: record.i, s: record.s, t: record.t };
  } catch {
    return undefined;
  }
}

function escapeIlike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function jobSummary(row: JobListRow) {
  return {
    id: row.id,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    title: row.title,
    lifecycle: row.lifecycle,
    mode: row.mode,
    no_site: row.no_site,
    version: row.version,
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
  };
}

function jobDetail(row: JobRow) {
  return {
    id: row.id,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    title: row.title,
    site_address: row.site_address_json ?? null,
    no_site: row.no_site,
    lifecycle: row.lifecycle,
    mode: row.mode,
    internal_notes: row.internal_notes,
    version: row.version,
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
    permitted_actions: [] as string[],
    quote_draft:
      row.quote_draft_id && row.quote_draft_version
        ? quoteDraftSummary(row.quote_draft_payload, row.quote_draft_id, row.quote_draft_version)
        : null,
    current_quote:
      row.current_quote_id && row.current_quote_number && row.current_quote_revision && row.current_quote_lifecycle
        ? quoteDocumentSummary({
            id: row.current_quote_id,
            number: row.current_quote_number,
            revision_no: row.current_quote_revision,
            lifecycle: row.current_quote_lifecycle,
            total_cents: row.current_quote_total ?? 0,
          })
        : null,
  };
}

async function provisionOwner(
  pool: Pool,
  access: VerifiedAccess,
): Promise<ProvisionRow | undefined> {
  const parsedEmail = parseOwnerEmail(access.email);
  if (!parsedEmail.ok) {
    return undefined;
  }
  return withApiRole(pool, async (client) => {
    const result = await client.query<ProvisionRow>(
      `select actor_id, workspace_id, account_status, display_email, setup_completed, first_sign_in, analytics_alias_id, workspace_version
       from identity.provision_owner($1::uuid, $2, $3)`,
      [access.sub, parsedEmail.display, parsedEmail.normalized],
    );
    return result.rows[0];
  });
}

function accountGate(row: ProvisionRow): "ok" | "suspended" | "locked" | "setup" {
  if (row.account_status === "suspended") {
    return "suspended";
  }
  if (row.account_status !== "active") {
    return "locked";
  }
  if (!row.setup_completed) {
    return "setup";
  }
  return "ok";
}

export function registerJobRoutes(
  app: FastifyInstance,
  deps: { verifyJwt?: JwtVerifier; pool?: Pool },
  options: { limiterAllow: (key: string) => { ok: true } | { ok: false; retryAfterSec: number } },
): void {
  async function requireOwner(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<ProvisionRow | undefined> {
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_REQUIRED, SIGN_IN_REQUIRED);
      return undefined;
    }
    if (!deps.verifyJwt || !deps.pool) {
      sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
      return undefined;
    }
    let access: VerifiedAccess;
    try {
      access = await deps.verifyJwt(token);
    } catch (error) {
      if (error instanceof JwtVerificationError) {
        sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
        return undefined;
      }
      sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      return undefined;
    }
    const parsedEmail = parseOwnerEmail(access.email);
    if (!parsedEmail.ok) {
      sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      return undefined;
    }
    const limited = options.limiterAllow(access.sub);
    if (!limited.ok) {
      const result = fail(request.id, API_ERROR_CODES.RATE_LIMITED, "Too many requests. Try again later.");
      void reply.header("Retry-After", String(limited.retryAfterSec));
      void reply.status(result.status).send(result.body);
      return undefined;
    }
    let owner: ProvisionRow | undefined;
    try {
      owner = await provisionOwner(deps.pool, access);
    } catch {
      sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
      return undefined;
    }
    if (!owner) {
      sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      return undefined;
    }
    const gate = accountGate(owner);
    if (gate === "suspended") {
      sendFail(request, reply, API_ERROR_CODES.ACCOUNT_SUSPENDED, "This account cannot make changes.");
      return undefined;
    }
    if (gate === "locked") {
      sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
      return undefined;
    }
    if (gate === "setup") {
      sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      return undefined;
    }
    return owner;
  }

  app.get("/v1/jobs", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    const queryRecord: Record<string, unknown> = {};
    const rawQuery = request.query as Record<string, unknown>;
    for (const key of Object.keys(rawQuery ?? {})) {
      queryRecord[key] = firstQuery(rawQuery[key]);
    }
    const parsed = parseJobListQuery(queryRecord);
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    let cursor: JobCursor | undefined;
    if (parsed.value.cursor) {
      cursor = decodeJobCursor(parsed.value.cursor);
      if (!cursor || cursor.s !== parsed.value.search || cursor.t !== parsed.value.state) {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
          field_errors: [{ field: "cursor", message: "Enter a valid value." }],
        });
      }
    }
    try {
      const rows = await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        const result = await client.query<JobListRow>(
          `select j.id, j.customer_id, c.name as customer_name, j.title, j.lifecycle, j.mode,
                  j.no_site, j.version, j.created_at, j.updated_at
           from commercial.jobs j
           join commercial.customers c
             on c.workspace_id = j.workspace_id and c.id = j.customer_id
           where (
             ($1 = 'finished' and j.lifecycle = 'finished')
             or ($1 = 'archived' and j.lifecycle = 'archived')
             or ($1 = 'open' and j.lifecycle in ('draft', 'active', 'invoiced', 'canceled'))
           )
             and (
               $2::text is null
               or j.title ilike '%' || $2 || '%' escape chr(92)
               or c.name ilike '%' || $2 || '%' escape chr(92)
             )
             and (
               $3::timestamptz is null
               or (j.updated_at, j.id) < ($3::timestamptz, $4::uuid)
             )
           order by j.updated_at desc, j.id desc
           limit $5`,
          [
            parsed.value.state,
            parsed.value.search ? escapeIlike(parsed.value.search) : null,
            cursor?.u ?? null,
            cursor?.i ?? null,
            parsed.value.limit + 1,
          ],
        );
        return result.rows;
      });
      const hasMore = rows.length > parsed.value.limit;
      const page = hasMore ? rows.slice(0, parsed.value.limit) : rows;
      const last = page[page.length - 1];
      const next_cursor =
        hasMore && last
          ? encodeJobCursor({
              u: asIso(last.updated_at),
              i: last.id,
              s: parsed.value.search,
              t: parsed.value.state,
            })
          : null;
      return success(request.id, { items: page.map(jobSummary), next_cursor });
    } catch {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.post("/v1/jobs", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_REQUIRED, SIGN_IN_REQUIRED);
    }
    if (!deps.verifyJwt || !deps.pool) {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
    const key = idempotencyKey(request);
    if (!key || !UUID.test(key)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Idempotency-Key UUID is required.", {
        field_errors: [{ field: "Idempotency-Key", message: "UUID required" }],
      });
    }
    let access: VerifiedAccess;
    try {
      access = await deps.verifyJwt(token);
    } catch {
      return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
    }
    const parsedEmail = parseOwnerEmail(access.email);
    if (!parsedEmail.ok) {
      return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
    }
    const limited = options.limiterAllow(access.sub);
    if (!limited.ok) {
      const result = fail(request.id, API_ERROR_CODES.RATE_LIMITED, "Too many requests. Try again later.");
      void reply.header("Retry-After", String(limited.retryAfterSec));
      return reply.status(result.status).send(result.body);
    }
    const body = request.body === undefined || request.body === null ? {} : request.body;
    const parsed = parseJobCreate(body);
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    const hash = requestHash(body);
    try {
      const row = await withApiRole(deps.pool, async (client) => {
        const owner = await client.query<ProvisionRow>(
          `select actor_id, workspace_id, account_status, display_email, setup_completed, first_sign_in, analytics_alias_id, workspace_version
           from identity.provision_owner($1::uuid, $2, $3)`,
          [access.sub, parsedEmail.display, parsedEmail.normalized],
        );
        const provisioned = owner.rows[0];
        if (!provisioned) {
          return undefined;
        }
        if (provisioned.account_status === "suspended") {
          return { kind: "suspended" as const };
        }
        if (provisioned.account_status !== "active") {
          return { kind: "locked" as const };
        }
        if (!provisioned.setup_completed) {
          return { kind: "setup" as const };
        }
        const created = await client.query<JobRow>(
          `select id, workspace_id, customer_id, customer_name, title, site_address_json, no_site,
                  lifecycle, mode, internal_notes, version, created_at, updated_at, replayed
           from commercial.create_job(
             $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid,
             $6, $7, $8::jsonb, $9::boolean, $10, $11
           )`,
          [
            provisioned.actor_id,
            key,
            hash,
            request.id,
            parsed.value.id,
            parsed.value.customer_name,
            parsed.value.title,
            parsed.value.site_address ? JSON.stringify(parsed.value.site_address) : null,
            parsed.value.no_site,
            parsed.value.internal_notes,
            parsed.value.mode,
          ],
        );
        return { kind: "ok" as const, row: created.rows[0] };
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      }
      if (row.kind === "suspended") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_SUSPENDED, "This account cannot make changes.");
      }
      if (row.kind === "locked") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
      }
      if (row.kind === "setup") {
        return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      }
      if (!row.row) {
        return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      }
      return success(request.id, jobDetail(row.row));
    } catch (error) {
      const code = pgCode(error);
      if (code === "P0004") {
        return sendFail(request, reply, API_ERROR_CODES.IDEMPOTENCY_MISMATCH, "Idempotency key was reused with a different body.");
      }
      if (code === "P0003") {
        return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      }
      if (code === "23505") {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
          field_errors: [{ field: "id", message: "This job id is already used." }],
        });
      }
      if (code === "23514" || code === "22023") {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.");
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.get("/v1/jobs/:jobId", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    const params = request.params as { jobId?: string };
    if (!isClientUuid(params.jobId)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "jobId", message: "A job UUID is required." }],
      });
    }
    try {
      const row = await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        await client.query("select commercial.expire_due_job_approvals($1::uuid, $2::uuid)", [
          owner.workspace_id,
          params.jobId,
        ]);
        const result = await client.query<JobRow>(
          `select j.id, j.workspace_id, j.customer_id, c.name as customer_name, j.title, j.site_address_json,
                  j.no_site, j.lifecycle, j.mode, j.internal_notes, j.version, j.created_at, j.updated_at,
                  d.id as quote_draft_id, d.version as quote_draft_version, d.payload_json as quote_draft_payload,
                  q.id as current_quote_id, q.number as current_quote_number, q.revision_no as current_quote_revision,
                  q.lifecycle as current_quote_lifecycle, q.total_cents as current_quote_total
           from commercial.jobs j
           join commercial.customers c
             on c.workspace_id = j.workspace_id and c.id = j.customer_id
           left join commercial.document_drafts d
             on d.workspace_id = j.workspace_id
            and d.job_id = j.id
            and d.kind = 'quote'
            and d.draft_state = 'editing'
           left join commercial.documents q
             on q.workspace_id = j.workspace_id
            and q.id = j.current_quote_id
           where j.id = $1`,
          [params.jobId],
        );
        return result.rows[0];
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, JOB_NOT_FOUND);
      }
      return success(request.id, jobDetail(row));
    } catch {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });
}
