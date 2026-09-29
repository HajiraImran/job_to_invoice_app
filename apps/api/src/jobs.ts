import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { encryptRecipientEmail, encryptUtf8, parseVersionedSecret } from "@job-to-invoice/config";
import {
  isClientUuid,
  parseEmptyObjectBody,
  parseJobArchive,
  parseJobCreate,
  parseJobListQuery,
  parseOwnerEmail,
  parseWithdrawBody,
} from "@job-to-invoice/schemas";
import type { Pool } from "pg";
import { invoiceDraftSummary, quoteDraftSummary } from "./drafts.ts";
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
  related_job_id?: string | null;
  archived_from_state?: string | null;
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
  active_invoice_id?: string | null;
  active_invoice_number?: string | null;
  active_invoice_revision?: number | null;
  active_invoice_lifecycle?: string | null;
  active_invoice_total?: string | number | null;
  active_invoice_due?: Date | string | null;
  latest_invoice_id?: string | null;
  latest_invoice_number?: string | null;
  latest_invoice_revision?: number | null;
  latest_invoice_lifecycle?: string | null;
  latest_invoice_total?: string | number | null;
  latest_invoice_due?: Date | string | null;
  invoice_draft_id?: string | null;
  invoice_draft_version?: number | null;
  invoice_draft_payload?: unknown;
  change_draft_id?: string | null;
  change_draft_version?: number | null;
  change_draft_payload?: unknown;
  latest_change_id?: string | null;
  latest_change_number?: string | null;
  latest_change_revision?: number | null;
  latest_change_lifecycle?: string | null;
  latest_change_total?: string | number | null;
  latest_change_request_state?: string | null;
  latest_change_additions?: unknown;
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

type JobCursor = { u: string; i: string; s: string | null; t: "open" | "finished" | "archived" | "all"; c: string | null };

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

export function encodeJobCursor(payload: Omit<JobCursor, "c"> & { c?: string | null }): string {
  return Buffer.from(JSON.stringify({ ...payload, c: payload.c ?? null }), "utf8").toString("base64url");
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
    if (record.t !== "open" && record.t !== "finished" && record.t !== "archived" && record.t !== "all") {
      return undefined;
    }
    if (record.c !== undefined && record.c !== null && !isClientUuid(record.c)) {
      return undefined;
    }
    return { u: record.u, i: record.i, s: record.s, t: record.t, c: typeof record.c === "string" ? record.c : null };
  } catch {
    return undefined;
  }
}

function escapeIlike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function changeDraftCounts(payload: unknown): { additions_count: number; reductions_count: number } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { additions_count: 0, reductions_count: 0 };
  }
  const record = payload as { additions?: unknown; reductions?: unknown };
  return {
    additions_count: Array.isArray(record.additions) ? record.additions.length : 0,
    reductions_count: Array.isArray(record.reductions) ? record.reductions.length : 0,
  };
}

function changeAdditionLines(raw: unknown): Array<{ description: string; total_cents: number }> {
  if (!Array.isArray(raw)) {
    return [];
  }
  const lines: Array<{ description: string; total_cents: number }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as { description?: unknown; total_cents?: unknown };
    if (typeof row.description !== "string" || row.description.length === 0) {
      continue;
    }
    const total = typeof row.total_cents === "number" ? row.total_cents : Number(row.total_cents);
    if (!Number.isInteger(total)) {
      continue;
    }
    lines.push({ description: row.description, total_cents: total });
  }
  return lines;
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
  const canCreateInvoice =
    (row.lifecycle === "active" && row.current_quote_lifecycle === "accepted" && !row.active_invoice_id) ||
    (row.mode === "direct_invoice" && row.lifecycle === "draft" && !row.active_invoice_id);
  const canViewInvoice = Boolean(row.active_invoice_id || row.latest_invoice_id);
  const canReplaceInvoice =
    row.lifecycle === "invoiced" && !row.active_invoice_id && row.latest_invoice_lifecycle === "voided";
  const canCreateChange =
    row.mode === "quote" &&
    row.lifecycle === "active" &&
    row.current_quote_lifecycle === "accepted" &&
    !row.active_invoice_id &&
    !row.latest_invoice_id;
  const canViewChange = Boolean(row.latest_change_id);
  const canDeleteJob = row.lifecycle === "draft";
  const canCancelJob = row.lifecycle === "active" || row.lifecycle === "invoiced";
  const canCreateLinkedJob = row.lifecycle === "canceled";
  const canArchiveJob =
    row.lifecycle === "active" ||
    row.lifecycle === "invoiced" ||
    row.lifecycle === "finished" ||
    row.lifecycle === "canceled";
  const canRestoreJob = row.lifecycle === "archived";
  const canFinishJob = row.lifecycle === "invoiced" && Boolean(row.active_invoice_id);
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
    related_job_id: row.related_job_id ?? null,
    archived_from_state: row.archived_from_state ?? null,
    version: row.version,
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
    permitted_actions: [
      ...(canCreateInvoice ? ["create_invoice"] : []),
      ...(canViewInvoice ? ["view_invoice"] : []),
      ...(canReplaceInvoice ? ["create_replacement"] : []),
      ...(canCreateChange ? ["create_change"] : []),
      ...(canViewChange ? ["view_change"] : []),
      ...(canDeleteJob ? ["delete_job"] : []),
      ...(canCancelJob ? ["cancel_job"] : []),
      ...(canCreateLinkedJob ? ["create_linked_job"] : []),
      ...(canArchiveJob ? ["archive_job"] : []),
      ...(canRestoreJob ? ["restore_job"] : []),
      ...(canFinishJob ? ["finish_job"] : []),
    ],
    quote_draft:
      row.quote_draft_id && row.quote_draft_version
        ? quoteDraftSummary(row.quote_draft_payload, row.quote_draft_id, row.quote_draft_version)
        : null,
    invoice_draft:
      row.invoice_draft_id && row.invoice_draft_version
        ? invoiceDraftSummary(row.invoice_draft_payload, row.invoice_draft_id, row.invoice_draft_version)
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
    active_invoice:
      row.active_invoice_id && row.active_invoice_number && row.active_invoice_revision && row.active_invoice_lifecycle
        ? {
            id: row.active_invoice_id,
            number: row.active_invoice_number,
            revision_no: row.active_invoice_revision,
            lifecycle: row.active_invoice_lifecycle,
            total_cents:
              typeof row.active_invoice_total === "number"
                ? row.active_invoice_total
                : Number(row.active_invoice_total ?? 0),
            due_date: row.active_invoice_due
              ? row.active_invoice_due instanceof Date
                ? row.active_invoice_due.toISOString().slice(0, 10)
                : String(row.active_invoice_due).slice(0, 10)
              : null,
          }
        : null,
    latest_invoice:
      row.latest_invoice_id && row.latest_invoice_number && row.latest_invoice_revision && row.latest_invoice_lifecycle
        ? {
            id: row.latest_invoice_id,
            number: row.latest_invoice_number,
            revision_no: row.latest_invoice_revision,
            lifecycle: row.latest_invoice_lifecycle,
            total_cents:
              typeof row.latest_invoice_total === "number"
                ? row.latest_invoice_total
                : Number(row.latest_invoice_total ?? 0),
            due_date: row.latest_invoice_due
              ? row.latest_invoice_due instanceof Date
                ? row.latest_invoice_due.toISOString().slice(0, 10)
                : String(row.latest_invoice_due).slice(0, 10)
              : null,
          }
        : null,
    change_draft:
      row.change_draft_id && row.change_draft_version
        ? {
            id: row.change_draft_id,
            version: row.change_draft_version,
            reason:
              row.change_draft_payload &&
              typeof row.change_draft_payload === "object" &&
              !Array.isArray(row.change_draft_payload) &&
              typeof (row.change_draft_payload as { reason?: unknown }).reason === "string"
                ? (row.change_draft_payload as { reason: string }).reason
                : "",
            ...changeDraftCounts(row.change_draft_payload),
          }
        : null,
    latest_change:
      row.latest_change_id && row.latest_change_number && row.latest_change_revision && row.latest_change_lifecycle
        ? {
            id: row.latest_change_id,
            number: row.latest_change_number,
            revision_no: row.latest_change_revision,
            lifecycle: row.latest_change_lifecycle,
            total_cents:
              typeof row.latest_change_total === "number"
                ? row.latest_change_total
                : Number(row.latest_change_total ?? 0),
            request_state: row.latest_change_request_state ?? null,
            additions: changeAdditionLines(row.latest_change_additions),
          }
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

function loadDeliverySecret(env?: Record<string, unknown>) {
  const raw = typeof env?.APPROVAL_DELIVERY_ENCRYPTION_KEY === "string" ? env.APPROVAL_DELIVERY_ENCRYPTION_KEY : undefined;
  if (!raw) {
    return undefined;
  }
  try {
    return parseVersionedSecret("APPROVAL_DELIVERY_ENCRYPTION_KEY", raw);
  } catch {
    return undefined;
  }
}

const JOB_DETAIL_SQL = `select j.id, j.workspace_id, j.customer_id, c.name as customer_name, j.title, j.site_address_json,
                  j.no_site, j.lifecycle, j.mode, j.internal_notes, j.related_job_id, j.archived_from_state, j.version, j.created_at, j.updated_at,
                  d.id as quote_draft_id, d.version as quote_draft_version, d.payload_json as quote_draft_payload,
                  idr.id as invoice_draft_id, idr.version as invoice_draft_version, idr.payload_json as invoice_draft_payload,
                  q.id as current_quote_id, q.number as current_quote_number, q.revision_no as current_quote_revision,
                  q.lifecycle as current_quote_lifecycle, q.total_cents as current_quote_total,
                  inv.id as active_invoice_id, inv.number as active_invoice_number, inv.revision_no as active_invoice_revision,
                  inv.lifecycle as active_invoice_lifecycle, inv.total_cents as active_invoice_total, inv.due_date as active_invoice_due,
                  latest_inv.id as latest_invoice_id, latest_inv.number as latest_invoice_number,
                  latest_inv.revision_no as latest_invoice_revision, latest_inv.lifecycle as latest_invoice_lifecycle,
                  latest_inv.total_cents as latest_invoice_total, latest_inv.due_date as latest_invoice_due,
                  cd.id as change_draft_id, cd.version as change_draft_version, cd.payload_json as change_draft_payload,
                  latest_chg.id as latest_change_id, latest_chg.number as latest_change_number,
                  latest_chg.revision_no as latest_change_revision, latest_chg.lifecycle as latest_change_lifecycle,
                  latest_chg.total_cents as latest_change_total, latest_chg.request_state as latest_change_request_state,
                  latest_chg.additions as latest_change_additions
           from commercial.jobs j
           join commercial.customers c
             on c.workspace_id = j.workspace_id and c.id = j.customer_id
           left join commercial.document_drafts d
             on d.workspace_id = j.workspace_id
            and d.job_id = j.id
            and d.kind = 'quote'
            and d.draft_state = 'editing'
           left join commercial.document_drafts idr
             on idr.workspace_id = j.workspace_id
            and idr.job_id = j.id
            and idr.kind = 'invoice'
            and idr.draft_state = 'editing'
           left join commercial.documents q
             on q.workspace_id = j.workspace_id
            and q.id = j.current_quote_id
           left join commercial.documents inv
             on inv.workspace_id = j.workspace_id
            and inv.id = j.active_invoice_id
           left join lateral (
             select d2.id, d2.number, d2.revision_no, d2.lifecycle, d2.total_cents, d2.due_date
             from commercial.documents d2
             where d2.workspace_id = j.workspace_id and d2.job_id = j.id and d2.kind = 'invoice'
             order by d2.issued_at desc, d2.id desc
             limit 1
           ) latest_inv on true
           left join commercial.document_drafts cd
             on cd.workspace_id = j.workspace_id
            and cd.job_id = j.id
            and cd.kind = 'change'
            and cd.draft_state = 'editing'
           left join lateral (
             select d3.id, d3.number, d3.revision_no, d3.lifecycle, d3.total_cents,
                    case
                      when d3.lifecycle = 'issued' then 'pending'
                      when d3.lifecycle = 'accepted' then 'approved'
                      when d3.lifecycle = 'declined' then 'declined'
                      else d3.lifecycle
                    end as request_state,
                    d3.snapshot_json->'additions' as additions
             from commercial.documents d3
             where d3.workspace_id = j.workspace_id and d3.job_id = j.id and d3.kind = 'change'
             order by d3.issued_at desc, d3.id desc
             limit 1
           ) latest_chg on true
           where j.id = $1`;

export function registerJobRoutes(
  app: FastifyInstance,
  deps: { verifyJwt?: JwtVerifier; pool?: Pool; env?: Record<string, unknown> },
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
      if (
        !cursor ||
        cursor.s !== parsed.value.search ||
        cursor.t !== parsed.value.state ||
        cursor.c !== parsed.value.customer_id
      ) {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
          field_errors: [{ field: "cursor", message: "Enter a valid value." }],
        });
      }
    }
    try {
      const rows = await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        if (parsed.value.customer_id) {
          const owned = await client.query(
            `select id from commercial.customers where id = $1`,
            [parsed.value.customer_id],
          );
          if (!owned.rows[0]) {
            return undefined;
          }
        }
        const result = await client.query<JobListRow>(
          `select j.id, j.customer_id, c.name as customer_name, j.title, j.lifecycle, j.mode,
                  j.no_site, j.version, j.created_at, j.updated_at
           from commercial.jobs j
           join commercial.customers c
             on c.workspace_id = j.workspace_id and c.id = j.customer_id
           where (
             ($1 = 'all')
             or ($1 = 'finished' and j.lifecycle = 'finished')
             or ($1 = 'archived' and j.lifecycle = 'archived')
             or ($1 = 'open' and j.lifecycle in ('draft', 'active', 'invoiced', 'canceled'))
           )
             and ($6::uuid is null or j.customer_id = $6::uuid)
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
            parsed.value.customer_id,
          ],
        );
        return result.rows;
      });
      if (!rows) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, "Customer was not found.");
      }
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
              c: parsed.value.customer_id,
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
        const created = parsed.value.customer_id
          ? await (async () => {
              await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [
                provisioned.workspace_id,
                provisioned.actor_id,
              ]);
              return client.query<JobRow>(
                `select id, workspace_id, customer_id, customer_name, title, site_address_json, no_site,
                        lifecycle, mode, internal_notes, related_job_id, version, created_at, updated_at, replayed
                 from commercial.create_job_for_customer(
                   $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::uuid,
                   $7, $8::jsonb, $9::boolean, $10, $11, $12::uuid
                 )`,
                [
                  provisioned.actor_id,
                  key,
                  hash,
                  request.id,
                  parsed.value.id,
                  parsed.value.customer_id,
                  parsed.value.title,
                  parsed.value.site_address ? JSON.stringify(parsed.value.site_address) : null,
                  parsed.value.no_site,
                  parsed.value.internal_notes,
                  parsed.value.mode,
                  parsed.value.related_job_id,
                ],
              );
            })()
          : await client.query<JobRow>(
          `select id, workspace_id, customer_id, customer_name, title, site_address_json, no_site,
                  lifecycle, mode, internal_notes, related_job_id, version, created_at, updated_at, replayed
           from commercial.create_job(
             $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid,
             $6, $7, $8::jsonb, $9::boolean, $10, $11, $12::uuid
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
            parsed.value.related_job_id,
          ],
        );
        const job = created.rows[0];
        if (!job) {
          return { kind: "ok" as const, row: job };
        }
        if (job.mode === "direct_invoice") {
          const opened = await client.query<{
            id: string;
            version: number;
            payload_json: unknown;
          }>(
            `select id, version, payload_json
             from commercial.open_direct_invoice_draft($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid)`,
            [provisioned.actor_id, randomUUID(), requestHash({ jobId: job.id }), request.id, job.id],
          );
          const draft = opened.rows[0];
          if (draft) {
            job.invoice_draft_id = draft.id;
            job.invoice_draft_version = draft.version;
            job.invoice_draft_payload = draft.payload_json;
          }
        }
        return { kind: "ok" as const, row: job };
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
      if (code === "P0044") {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "This job cannot be invoiced yet.");
      }
      if (code === "P0054") {
        return sendFail(request, reply, API_ERROR_CODES.RELATED_JOB_UNAVAILABLE, "Create a linked new job from a canceled job.");
      }
      if (code === "P0005") {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, "Customer was not found.");
      }
      if (code === "P0062") {
        return sendFail(request, reply, API_ERROR_CODES.CUSTOMER_ARCHIVED, "Restore this customer before creating a job.");
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
        const result = await client.query<JobRow>(JOB_DETAIL_SQL, [params.jobId]);
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

  app.delete("/v1/jobs/:jobId", async (request, reply) => {
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
    const empty = parseEmptyObjectBody(request.body);
    if (!empty.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: empty.field_errors,
      });
    }
    const key = idempotencyKey(request);
    if (!key || !UUID.test(key)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Idempotency-Key UUID is required.", {
        field_errors: [{ field: "Idempotency-Key", message: "UUID required" }],
      });
    }
    const hash = requestHash({ job_id: params.jobId, action: "delete" });
    try {
      const row = await withApiRole(deps.pool, async (client) => {
        const result = await client.query<{ id: string; deleted: boolean; replayed: boolean }>(
          `select id, deleted, replayed
           from commercial.delete_draft_job($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid)`,
          [owner.actor_id, key, hash, request.id, params.jobId],
        );
        return result.rows[0];
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, JOB_NOT_FOUND);
      }
      return success(request.id, { id: row.id, deleted: row.deleted, replayed: row.replayed });
    } catch (error) {
      const code = pgCode(error);
      if (code === "P0005") {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, JOB_NOT_FOUND);
      }
      if (code === "P0004") {
        return sendFail(request, reply, API_ERROR_CODES.IDEMPOTENCY_MISMATCH, "Idempotency key was reused with a different body.");
      }
      if (code === "P0003") {
        return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      }
      if (code === "P0052") {
        return sendFail(request, reply, API_ERROR_CODES.JOB_NOT_DELETABLE, "Published jobs cannot be deleted.");
      }
      if (code === "22023") {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.");
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.post("/v1/jobs/:jobId/cancel", async (request, reply) => {
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
    const parsed = parseWithdrawBody(request.body);
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    const key = idempotencyKey(request);
    if (!key || !UUID.test(key)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Idempotency-Key UUID is required.", {
        field_errors: [{ field: "Idempotency-Key", message: "UUID required" }],
      });
    }
    const delivery = loadDeliverySecret(deps.env);
    if (!delivery) {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
    const hash = requestHash({ job_id: params.jobId, action: "cancel", reason: parsed.value.reason });
    const payload = encryptUtf8(JSON.stringify({ kind: "withdrawn" }), delivery);
    const packedEmail = encryptRecipientEmail("placeholder@invalid.example", delivery);
    try {
      const row = await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        const canceled = await client.query<{ id: string; lifecycle: string; version: number; replayed: boolean }>(
          `select id, lifecycle, version, replayed
           from commercial.cancel_job(
             $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6,
             $7::bytea, $8, $9::integer, $10::bytea, $11::bytea
           )`,
          [
            owner.actor_id,
            key,
            hash,
            request.id,
            params.jobId,
            parsed.value.reason,
            Buffer.concat([packedEmail.nonce, packedEmail.ciphertext]),
            payload.algorithm,
            payload.keyVersion,
            payload.nonce,
            payload.ciphertext,
          ],
        );
        const result = canceled.rows[0];
        if (!result) {
          return undefined;
        }
        const detail = await client.query<JobRow>(JOB_DETAIL_SQL, [result.id]);
        if (!detail.rows[0]) {
          return undefined;
        }
        return { ...detail.rows[0], replayed: result.replayed };
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, JOB_NOT_FOUND);
      }
      return success(request.id, jobDetail(row));
    } catch (error) {
      const code = pgCode(error);
      if (code === "P0005") {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, JOB_NOT_FOUND);
      }
      if (code === "P0004") {
        return sendFail(request, reply, API_ERROR_CODES.IDEMPOTENCY_MISMATCH, "Idempotency key was reused with a different body.");
      }
      if (code === "P0003") {
        return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      }
      if (code === "P0053") {
        return sendFail(request, reply, API_ERROR_CODES.JOB_NOT_CANCELABLE, "This job cannot be canceled.");
      }
      if (code === "22023") {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.");
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.post("/v1/jobs/:jobId/archive", async (request, reply) => {
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
    const parsed = parseJobArchive(request.body);
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    const key = idempotencyKey(request);
    if (!key || !UUID.test(key)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Idempotency-Key UUID is required.", {
        field_errors: [{ field: "Idempotency-Key", message: "UUID required" }],
      });
    }
    const hash = requestHash({ job_id: params.jobId, action: "archive", archived: parsed.value.archived });
    try {
      const row = await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        const archived = await client.query<{
          id: string;
          lifecycle: string;
          archived_from_state: string | null;
          version: number;
          replayed: boolean;
        }>(
          `select id, lifecycle, archived_from_state, version, replayed
           from commercial.archive_job($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::boolean)`,
          [owner.actor_id, key, hash, request.id, params.jobId, parsed.value.archived],
        );
        const result = archived.rows[0];
        if (!result) {
          return undefined;
        }
        const detail = await client.query<JobRow>(JOB_DETAIL_SQL, [result.id]);
        if (!detail.rows[0]) {
          return undefined;
        }
        return { ...detail.rows[0], replayed: result.replayed };
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, JOB_NOT_FOUND);
      }
      return success(request.id, jobDetail(row));
    } catch (error) {
      const code = pgCode(error);
      if (code === "P0005") {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, JOB_NOT_FOUND);
      }
      if (code === "P0004") {
        return sendFail(request, reply, API_ERROR_CODES.IDEMPOTENCY_MISMATCH, "Idempotency key was reused with a different body.");
      }
      if (code === "P0003") {
        return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      }
      if (code === "P0012") {
        return sendFail(request, reply, API_ERROR_CODES.APPROVAL_PENDING, "Withdraw or wait for the pending approval before archiving.");
      }
      if (code === "P0055") {
        return sendFail(request, reply, API_ERROR_CODES.JOB_NOT_ARCHIVABLE, "This job cannot be archived or restored.");
      }
      if (code === "22023") {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.");
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.post("/v1/jobs/:jobId/finish", async (request, reply) => {
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
    const parsed = parseEmptyObjectBody(request.body);
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    const key = idempotencyKey(request);
    if (!key || !UUID.test(key)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Idempotency-Key UUID is required.", {
        field_errors: [{ field: "Idempotency-Key", message: "UUID required" }],
      });
    }
    const hash = requestHash({ job_id: params.jobId, action: "finish" });
    try {
      const row = await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        const finished = await client.query<{ id: string; lifecycle: string; version: number; replayed: boolean }>(
          `select id, lifecycle, version, replayed
           from commercial.finish_job($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid)`,
          [owner.actor_id, key, hash, request.id, params.jobId],
        );
        const result = finished.rows[0];
        if (!result) {
          return undefined;
        }
        const detail = await client.query<JobRow>(JOB_DETAIL_SQL, [result.id]);
        if (!detail.rows[0]) {
          return undefined;
        }
        return { ...detail.rows[0], replayed: result.replayed };
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, JOB_NOT_FOUND);
      }
      return success(request.id, jobDetail(row));
    } catch (error) {
      const code = pgCode(error);
      if (code === "P0005") {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, JOB_NOT_FOUND);
      }
      if (code === "P0004") {
        return sendFail(request, reply, API_ERROR_CODES.IDEMPOTENCY_MISMATCH, "Idempotency key was reused with a different body.");
      }
      if (code === "P0003") {
        return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      }
      if (code === "P0056") {
        return sendFail(
          request,
          reply,
          API_ERROR_CODES.JOB_NOT_FINISHABLE,
          "Finish is allowed after the invoice is settled or waived by credits.",
        );
      }
      if (code === "22023") {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.");
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });
}
