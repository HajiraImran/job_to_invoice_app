import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { calculateDraftDocument, isDomainError } from "@job-to-invoice/domain";
import {
  isClientUuid,
  parseDraftPayload,
  parseOwnerEmail,
  type DraftLineInput,
  type DraftPayloadInput,
} from "@job-to-invoice/schemas";
import type { Pool } from "pg";
import { withApiRole, withTenant } from "./db.ts";
import { API_ERROR_CODES, fail, success } from "./envelope.ts";
import { bearerToken, JwtVerificationError, type JwtVerifier, type VerifiedAccess } from "./jwt.ts";

const GENERIC_AUTH = "Could not verify your session.";
const SIGN_IN_REQUIRED = "Sign in required.";
const DRAFT_NOT_FOUND = "Quote draft was not found.";
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

function ifMatchVersion(request: FastifyRequest): number | undefined {
  const raw = request.headers["if-match"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    return undefined;
  }
  const cleaned = value.replace(/^W\//, "").replaceAll('"', "").trim();
  if (!/^[1-9]\d*$/.test(cleaned)) {
    return undefined;
  }
  return Number(cleaned);
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

export function emptyDraftPayload(): DraftPayloadInput {
  return { notes: "", terms: "", expiry_days: 14, lines: [] };
}

export function payloadFromJson(raw: unknown): DraftPayloadInput {
  const parsed = parseDraftPayload(raw);
  if (!parsed.ok) {
    return emptyDraftPayload();
  }
  return parsed.value;
}

export function presentQuoteDraft(row: DraftRow) {
  const payload = payloadFromJson(row.payload_json);
  let totals;
  try {
    totals = calculateDraftDocument(payload.lines);
  } catch (error) {
    if (isDomainError(error)) {
      totals = calculateDraftDocument([]);
    } else {
      throw error;
    }
  }
  const calculatedById = new Map(totals.lines.map((line) => [line.client_line_id, line]));
  return {
    id: row.id,
    job_id: row.job_id,
    kind: row.kind,
    draft_state: row.draft_state,
    schema_version: row.schema_version,
    version: row.version,
    notes: payload.notes,
    terms: payload.terms,
    expiry_days: payload.expiry_days,
    default_tax_bp: row.default_tax_bp,
    currency: "USD",
    lines: payload.lines.map((line: DraftLineInput) => {
      const money = calculatedById.get(line.client_line_id);
      return {
        client_line_id: line.client_line_id,
        description: line.description,
        unit: line.unit,
        custom_unit_label: line.custom_unit_label,
        quantity: money?.quantity ?? line.quantity,
        unit_price_cents: line.unit_price_cents,
        discount_cents: line.discount_cents,
        tax_bp: line.tax_bp,
        gross_cents: money?.gross_cents ?? 0,
        net_cents: money?.net_cents ?? 0,
        tax_cents: money?.tax_cents ?? 0,
        total_cents: money?.total_cents ?? 0,
      };
    }),
    net_cents: totals.net_cents,
    tax_cents: totals.tax_cents,
    total_cents: totals.total_cents,
    tax_by_rate: totals.tax_by_rate,
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
  };
}

export function quoteDraftSummary(raw: unknown, id: string, version: number) {
  const presented = presentQuoteDraft({
    id,
    workspace_id: "",
    job_id: "",
    kind: "quote",
    draft_state: "editing",
    schema_version: 1,
    payload_json: raw,
    version,
    created_at: new Date(0),
    updated_at: new Date(0),
    default_tax_bp: 0,
  });
  return {
    id,
    version,
    line_count: presented.lines.length,
    net_cents: presented.net_cents,
    tax_cents: presented.tax_cents,
    total_cents: presented.total_cents,
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

function mapDraftWriteError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  notFoundMessage: string,
): ReturnType<typeof sendFail> | undefined {
  const code = pgCode(error);
  if (code === "P0001") {
    return sendFail(
      request,
      reply,
      API_ERROR_CODES.VERSION_CONFLICT,
      "This quote was updated elsewhere. Reload and try again.",
    );
  }
  if (code === "P0004") {
    return sendFail(
      request,
      reply,
      API_ERROR_CODES.IDEMPOTENCY_MISMATCH,
      "Idempotency key was reused with a different body.",
    );
  }
  if (code === "P0003") {
    return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
  }
  if (code === "P0005") {
    return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, notFoundMessage);
  }
  if (code === "P0006") {
    return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Direct invoice jobs cannot open a quote.", {
      field_errors: [{ field: "mode", message: "Direct invoice jobs cannot open a quote." }],
    });
  }
  if (code === "P0007") {
    return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "This job cannot be edited as a quote draft.");
  }
  if (code === "23514" || code === "22023") {
    return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.");
  }
  return undefined;
}

export function registerDraftRoutes(
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

  app.post("/v1/jobs/:jobId/quote", async (request, reply) => {
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
    const hash = requestHash({ jobId: params.jobId });
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
        const opened = await client.query<DraftRow>(
          `select id, workspace_id, job_id, kind, draft_state, schema_version, payload_json,
                  version, created_at, updated_at, default_tax_bp, replayed
           from commercial.open_quote_draft($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid)`,
          [provisioned.actor_id, key, hash, request.id, params.jobId],
        );
        return { kind: "ok" as const, row: opened.rows[0] };
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
      return success(request.id, presentQuoteDraft(row.row));
    } catch (error) {
      const mapped = mapDraftWriteError(request, reply, error, JOB_NOT_FOUND);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.get("/v1/drafts/:draftId", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    const params = request.params as { draftId?: string };
    if (!isClientUuid(params.draftId)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "draftId", message: "A draft UUID is required." }],
      });
    }
    try {
      const row = await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        const result = await client.query<DraftRow>(
          `select d.id, d.workspace_id, d.job_id, d.kind, d.draft_state, d.schema_version, d.payload_json,
                  d.version, d.created_at, d.updated_at, w.default_tax_bp
           from commercial.document_drafts d
           join commercial.workspaces w on w.workspace_id = d.workspace_id
           where d.id = $1
             and d.kind = 'quote'`,
          [params.draftId],
        );
        return result.rows[0];
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, DRAFT_NOT_FOUND);
      }
      return success(request.id, presentQuoteDraft(row));
    } catch {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.patch("/v1/drafts/:draftId", async (request, reply) => {
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
    const expectedVersion = ifMatchVersion(request);
    if (expectedVersion === undefined) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "If-Match draft version is required.", {
        field_errors: [{ field: "If-Match", message: "Draft version required" }],
      });
    }
    const params = request.params as { draftId?: string };
    if (!isClientUuid(params.draftId)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "draftId", message: "A draft UUID is required." }],
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
    const parsed = parseDraftPayload(body);
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    try {
      calculateDraftDocument(parsed.value.lines);
    } catch (error) {
      if (isDomainError(error)) {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, error.message, {
          field_errors: error.field ? [{ field: error.field, message: error.message }] : [],
        });
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
    const stored = {
      notes: parsed.value.notes,
      terms: parsed.value.terms,
      expiry_days: parsed.value.expiry_days,
      lines: parsed.value.lines,
    };
    const hash = requestHash({ body: stored, expectedVersion });
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
        const saved = await client.query<DraftRow>(
          `select id, workspace_id, job_id, kind, draft_state, schema_version, payload_json,
                  version, created_at, updated_at, default_tax_bp, replayed
           from commercial.save_quote_draft(
             $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::integer, $7::jsonb
           )`,
          [
            provisioned.actor_id,
            key,
            hash,
            request.id,
            params.draftId,
            expectedVersion,
            JSON.stringify(stored),
          ],
        );
        return { kind: "ok" as const, row: saved.rows[0] };
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
      return success(request.id, presentQuoteDraft(row.row));
    } catch (error) {
      const mapped = mapDraftWriteError(request, reply, error, DRAFT_NOT_FOUND);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });
}
