import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  calculateChangeOrder,
  type ChangeSnapshotV1,
  type QuoteSnapshotV1,
} from "@job-to-invoice/domain";
import {
  API_ERROR_CODES,
  emptyChangeDraft,
  isClientUuid,
  parseChangeDraft,
  parseOwnerEmail,
  type ChangeDraftInput,
} from "@job-to-invoice/schemas";
import type { Pool } from "pg";
import { withApiRole } from "./db.ts";
import { fail, success } from "./envelope.ts";
import { bearerToken, type JwtVerifier, type VerifiedAccess } from "./jwt.ts";

const GENERIC_AUTH = "Could not verify your session.";
const SIGN_IN_REQUIRED = "Sign in required.";
const DRAFT_NOT_FOUND = "Change draft was not found.";
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

type DraftRow = {
  id: string;
  workspace_id: string;
  job_id: string;
  kind: string;
  draft_state: string;
  schema_version: number;
  payload_json: unknown;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  default_tax_bp: number;
  replayed?: boolean;
};

export type ScopeSourceRow = {
  source_line_id: string;
  description: string;
  original_net_cents: string | number;
  original_tax_cents: string | number;
  remaining_net_cents: string | number;
  remaining_tax_cents: string | number;
};

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

function asCents(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

export function changeDraftFromJson(raw: unknown, expectedScope = 1): ChangeDraftInput {
  const parsed = parseChangeDraft(raw);
  if (!parsed.ok) {
    return emptyChangeDraft(expectedScope);
  }
  return parsed.value;
}

export function presentChangeDraft(row: DraftRow, sources: ScopeSourceRow[] = []) {
  const payload = changeDraftFromJson(row.payload_json);
  let totals = {
    previous_total_cents: 0,
    change_including_tax_cents: 0,
    new_agreed_total_cents: 0,
  };
  try {
    const previous = sources.reduce((sum, row) => sum + asCents(row.remaining_net_cents) + asCents(row.remaining_tax_cents), 0);
    if (payload.additions.length + payload.reductions.length > 0) {
      const calculated = calculateChangeOrder({
        previous_total_cents: previous,
        additions: payload.additions,
        reductions: payload.reductions,
        sources: sources.map((source) => ({
          source_line_id: source.source_line_id,
          original_net_cents: asCents(source.original_net_cents),
          original_tax_cents: asCents(source.original_tax_cents),
          accepted_net_reductions_cents: asCents(source.original_net_cents) - asCents(source.remaining_net_cents),
        })),
        reason: payload.reason || null,
      });
      totals = {
        previous_total_cents: calculated.previous_total_cents,
        change_including_tax_cents: calculated.change_including_tax_cents,
        new_agreed_total_cents: calculated.new_agreed_total_cents,
      };
    } else {
      totals.previous_total_cents = previous;
      totals.new_agreed_total_cents = previous;
    }
  } catch {
    /* keep zeros when the draft is still incomplete */
  }
  return {
    id: row.id,
    job_id: row.job_id,
    kind: row.kind,
    draft_state: row.draft_state,
    schema_version: row.schema_version,
    version: row.version,
    reason: payload.reason,
    expected_scope_version: payload.expected_scope_version,
    expiry_days: payload.expiry_days,
    additions: payload.additions,
    reductions: payload.reductions,
    sources: sources.map((source) => ({
      source_line_id: source.source_line_id,
      description: source.description,
      original_net_cents: asCents(source.original_net_cents),
      original_tax_cents: asCents(source.original_tax_cents),
      remaining_net_cents: asCents(source.remaining_net_cents),
      remaining_tax_cents: asCents(source.remaining_tax_cents),
    })),
    ...totals,
    default_tax_bp: row.default_tax_bp,
    currency: "USD",
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
  };
}

export async function loadAcceptedScopeSources(
  client: { query: <T>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }> },
  workspaceId: string,
  jobId: string,
): Promise<ScopeSourceRow[]> {
  const result = await client.query<ScopeSourceRow>(
    `select dl.id as source_line_id, dl.description,
            max(origin.net_delta_cents) as original_net_cents,
            max(origin.tax_delta_cents) as original_tax_cents,
            coalesce(sum(se.net_delta_cents), 0) as remaining_net_cents,
            coalesce(sum(se.tax_delta_cents), 0) as remaining_tax_cents
     from commercial.document_lines dl
     join commercial.scope_entries origin
       on origin.workspace_id = dl.workspace_id
      and origin.source_line_id = dl.id
      and origin.event_kind = 'add'
     left join commercial.scope_entries se
       on se.workspace_id = dl.workspace_id and se.source_line_id = dl.id
     where origin.workspace_id = $1 and origin.job_id = $2
     group by dl.id
     order by min(origin.scope_version), dl.position, dl.id`,
    [workspaceId, jobId],
  );
  return result.rows;
}

export function mapChangeError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  notFoundMessage: string,
) {
  const code = pgCode(error);
  if (code === "P0001") {
    return sendFail(request, reply, API_ERROR_CODES.VERSION_CONFLICT, "This change draft was updated elsewhere. Reload and try again.");
  }
  if (code === "P0004") {
    return sendFail(request, reply, API_ERROR_CODES.IDEMPOTENCY_MISMATCH, "Idempotency key was reused with a different body.");
  }
  if (code === "P0003") {
    return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
  }
  if (code === "P0005") {
    return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, notFoundMessage);
  }
  if (code === "P0006") {
    return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Direct invoice jobs cannot add change orders.");
  }
  if (code === "P0008") {
    return sendFail(request, reply, API_ERROR_CODES.PREVIEW_CHANGED, "This preview is out of date. Review the change again before publishing.");
  }
  if (code === "P0009") {
    return sendFail(request, reply, API_ERROR_CODES.ENTITLEMENT_REQUIRED, "This job cannot publish a change order.");
  }
  if (code === "P0012") {
    return sendFail(request, reply, API_ERROR_CODES.APPROVAL_PENDING, "This job already has a pending approval request.");
  }
  if (code === "P0034") {
    return sendFail(request, reply, API_ERROR_CODES.SCOPE_CHANGED, "Accepted scope changed. Rebase this change and review it again.");
  }
  if (code === "P0044") {
    return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Change orders are available after quote acceptance and before invoice issue.");
  }
  if (code === "P0051") {
    return sendFail(request, reply, API_ERROR_CODES.CREDIT_EXCEEDS_SOURCE, "That reduction is more than the remaining amount on the source line.");
  }
  if (code === "23514" || code === "22023") {
    return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.");
  }
  return undefined;
}

export function buildChangeSnapshot(input: {
  business: QuoteSnapshotV1["business"];
  customer: QuoteSnapshotV1["customer"];
  job: QuoteSnapshotV1["job"];
  terms: string;
  payload: ChangeDraftInput;
  sources: ScopeSourceRow[];
  issueDate: string;
  expiryLocalDate: string;
  expiryTimezone: string;
  expiresAt: string;
}): ChangeSnapshotV1 {
  const previousNet = input.sources.reduce((sum, row) => sum + asCents(row.remaining_net_cents), 0);
  const previousTax = input.sources.reduce((sum, row) => sum + asCents(row.remaining_tax_cents), 0);
  const calculated = calculateChangeOrder({
    previous_total_cents: previousNet + previousTax,
    additions: input.payload.additions,
    reductions: input.payload.reductions,
    sources: input.sources.map((source) => ({
      source_line_id: source.source_line_id,
      original_net_cents: asCents(source.original_net_cents),
      original_tax_cents: asCents(source.original_tax_cents),
      accepted_net_reductions_cents: asCents(source.original_net_cents) - asCents(source.remaining_net_cents),
    })),
    reason: input.payload.reason || null,
  });
  const additions = calculated.additions.map((line, index) => {
    const source = input.payload.additions[index];
    return {
      position: index + 1,
      client_line_id: source?.client_line_id ?? line.client_line_id ?? "",
      description: source?.description ?? "",
      unit: source?.unit ?? "item",
      custom_unit_label: source?.custom_unit_label ?? null,
      quantity: line.quantity,
      unit_price_cents: line.unit_price_cents,
      discount_cents: line.discount_cents,
      tax_bp: line.tax_bp,
      gross_cents: line.gross_cents,
      net_cents: line.net_cents,
      tax_cents: line.tax_cents,
      total_cents: line.total_cents,
    };
  });
  const reductions = calculated.reductions.map((line, index) => {
    const source = input.payload.reductions[index];
    const origin = input.sources.find((item) => item.source_line_id === source?.source_line_id);
    return {
      position: additions.length + index + 1,
      source_line_id: source?.source_line_id ?? "",
      description: origin?.description ?? "Reduction",
      net_credit_cents: source?.net_credit_cents ?? line.net_reduction_cents,
      net_reduction_cents: line.net_reduction_cents,
      tax_reduction_cents: line.tax_reduction_cents,
      total_reduction_cents: line.total_reduction_cents,
    };
  });
  const newNet = previousNet + calculated.addition_net_cents - calculated.reduction_net_cents;
  const newTax = previousTax + calculated.addition_tax_cents - calculated.reduction_tax_cents;
  return {
    schema_version: 1,
    kind: "change",
    currency: "USD",
    business: input.business,
    customer: input.customer,
    job: input.job,
    reason: calculated.reason ?? "",
    notes: "",
    terms: input.terms,
    expiry_days: input.payload.expiry_days,
    expiry_local_date: input.expiryLocalDate,
    expiry_timezone: input.expiryTimezone,
    expires_at: input.expiresAt,
    issue_date: input.issueDate,
    expected_scope_version: input.payload.expected_scope_version,
    previous_net_cents: previousNet,
    previous_tax_cents: previousTax,
    previous_total_cents: calculated.previous_total_cents,
    addition_net_cents: calculated.addition_net_cents,
    addition_tax_cents: calculated.addition_tax_cents,
    addition_total_cents: calculated.addition_total_cents,
    reduction_net_cents: calculated.reduction_net_cents,
    reduction_tax_cents: calculated.reduction_tax_cents,
    reduction_total_cents: calculated.reduction_total_cents,
    change_including_tax_cents: calculated.change_including_tax_cents,
    new_agreed_total_cents: calculated.new_agreed_total_cents,
    additions,
    reductions,
    net_cents: newNet,
    tax_cents: newTax,
    total_cents: calculated.new_agreed_total_cents,
  };
}

export function registerChangeRoutes(
  app: FastifyInstance,
  deps: { verifyJwt?: JwtVerifier; pool?: Pool },
  options: { limiterAllow: (key: string) => { ok: true } | { ok: false; retryAfterSec: number } },
): void {
  app.post("/v1/jobs/:jobId/changes", async (request, reply) => {
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
    const params = request.params as { jobId?: string };
    if (!isClientUuid(params.jobId)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "jobId", message: "A job UUID is required." }],
      });
    }
    const jobId = params.jobId;
    if (request.body !== undefined && request.body !== null && request.body !== "") {
      if (typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body as object).length > 0) {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
          field_errors: [{ field: "body", message: "Unknown fields are not allowed." }],
        });
      }
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
    const hash = requestHash({ jobId });
    try {
      const opened = await withApiRole(deps.pool, async (client) => {
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
        await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [
          provisioned.workspace_id,
          provisioned.actor_id,
        ]);
        const draft = await client.query<DraftRow>(
          `select id, workspace_id, job_id, kind, draft_state, schema_version, payload_json,
                  version, created_at, updated_at, 0 as default_tax_bp, replayed
           from commercial.open_change_draft($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid)`,
          [provisioned.actor_id, key, hash, request.id, jobId],
        );
        const sources = await loadAcceptedScopeSources(client, provisioned.workspace_id, jobId);
        const tax = await client.query<{ default_tax_bp: number }>(
          "select default_tax_bp from commercial.workspaces where workspace_id = $1",
          [provisioned.workspace_id],
        );
        const row = draft.rows[0];
        if (row) {
          row.default_tax_bp = tax.rows[0]?.default_tax_bp ?? 0;
        }
        return { kind: "ok" as const, row, sources };
      });
      if (!opened) {
        return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      }
      if (opened.kind === "suspended") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_SUSPENDED, "This account cannot make changes.");
      }
      if (opened.kind === "locked") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
      }
      if (opened.kind === "setup") {
        return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      }
      if (!opened.row) {
        return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      }
      return success(request.id, presentChangeDraft(opened.row, opened.sources));
    } catch (error) {
      const mapped = mapChangeError(request, reply, error, JOB_NOT_FOUND);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });
}

export { DRAFT_NOT_FOUND };
