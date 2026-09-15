import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  buildQuoteSnapshot,
  canonicalizeToBytes,
  isDomainError,
  type QuoteSnapshotAddress,
  type QuoteSnapshotV1,
} from "@job-to-invoice/domain";
import {
  addCalendarDays,
  API_ERROR_CODES,
  endOfLocalDateUtc,
  isClientUuid,
  parseDraftPayload,
  parseOwnerEmail,
  parseQuotePublish,
  PREVIEW_TTL_MS,
  zonedCalendarDate,
  type DraftPayloadInput,
} from "@job-to-invoice/schemas";
import type { Pool } from "pg";
import { payloadFromJson } from "./drafts.ts";
import { withApiRole, withTenant } from "./db.ts";
import { fail, success } from "./envelope.ts";
import { bearerToken, JwtVerificationError, type JwtVerifier, type VerifiedAccess } from "./jwt.ts";

const GENERIC_AUTH = "Could not verify your session.";
const SIGN_IN_REQUIRED = "Sign in required.";
const DRAFT_NOT_FOUND = "Quote draft was not found.";
const DOCUMENT_NOT_FOUND = "Quote was not found.";
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

type PreviewContext = {
  draft_id: string;
  job_id: string;
  version: number;
  payload_json: unknown;
  default_tax_bp: number;
  timezone: string;
  business_name: string;
  legal_name: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string | null;
  address_json: unknown;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  billing_address_json: unknown;
  title: string;
  site_address_json: unknown;
  no_site: boolean;
};

type PublishRow = {
  id: string;
  workspace_id: string;
  job_id: string;
  draft_id: string;
  kind: string;
  number: string;
  revision_no: number;
  lifecycle: string;
  issued_at: Date | string;
  issue_date: Date | string;
  currency: string;
  net_cents: string | number;
  tax_cents: string | number;
  total_cents: string | number;
  snapshot_json: QuoteSnapshotV1;
  schema_version: number;
  snapshot_sha256: string;
  pdf_state: string;
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

function asDate(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function asCents(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function snapshotAddress(raw: unknown): QuoteSnapshotAddress | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.line1 !== "string" || typeof record.city !== "string" || typeof record.state !== "string" || typeof record.postal_code !== "string") {
    return null;
  }
  return {
    line1: record.line1,
    line2: typeof record.line2 === "string" && record.line2.length > 0 ? record.line2 : null,
    city: record.city,
    state: record.state,
    postal_code: record.postal_code,
  };
}

export function presentPublishedQuote(row: PublishRow, pdfState = row.pdf_state) {
  const snapshot = row.snapshot_json;
  return {
    id: row.id,
    job_id: row.job_id,
    draft_id: row.draft_id,
    kind: row.kind,
    number: row.number,
    revision_label: `R${row.revision_no}`,
    revision_no: row.revision_no,
    lifecycle: row.lifecycle,
    issued_at: asIso(row.issued_at),
    issue_date: asDate(row.issue_date),
    currency: row.currency,
    schema_version: row.schema_version,
    snapshot_sha256: row.snapshot_sha256,
    preview_hash: row.snapshot_sha256,
    pdf_state: pdfState,
    snapshot,
    net_cents: asCents(row.net_cents),
    tax_cents: asCents(row.tax_cents),
    total_cents: asCents(row.total_cents),
  };
}

export function quoteDocumentSummary(row: {
  id: string;
  number: string;
  revision_no: number;
  lifecycle: string;
  total_cents: string | number;
}) {
  return {
    id: row.id,
    number: row.number,
    revision_no: row.revision_no,
    lifecycle: row.lifecycle,
    total_cents: asCents(row.total_cents),
  };
}

function buildFrozenSnapshot(ctx: PreviewContext, payload: DraftPayloadInput, now = new Date()) {
  const issue_date = zonedCalendarDate(now, ctx.timezone);
  const expiry_local_date = addCalendarDays(issue_date, payload.expiry_days);
  const expires_at = endOfLocalDateUtc(expiry_local_date, ctx.timezone).toISOString();
  return buildQuoteSnapshot({
    business: {
      business_name: ctx.business_name,
      legal_name: ctx.legal_name,
      contact_name: ctx.contact_name,
      contact_email: ctx.contact_email,
      contact_phone: ctx.contact_phone,
      address: snapshotAddress(ctx.address_json),
      timezone: ctx.timezone,
      default_tax_bp: ctx.default_tax_bp,
    },
    customer: {
      name: ctx.customer_name,
      email: ctx.customer_email,
      phone: ctx.customer_phone,
      billing_address: snapshotAddress(ctx.billing_address_json),
    },
    job: {
      id: ctx.job_id,
      title: ctx.title,
      site_address: snapshotAddress(ctx.site_address_json),
      no_site: ctx.no_site,
    },
    notes: payload.notes,
    terms: payload.terms,
    expiry_days: payload.expiry_days,
    expiry_local_date,
    expiry_timezone: ctx.timezone,
    expires_at,
    issue_date,
    lines: payload.lines.map((line) => ({
      client_line_id: line.client_line_id,
      description: line.description,
      unit: line.unit,
      custom_unit_label: line.custom_unit_label,
      quantity: line.quantity,
      unit_price_cents: line.unit_price_cents,
      discount_cents: line.discount_cents,
      tax_bp: line.tax_bp,
    })),
  });
}

function mapPublishError(
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
    return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Direct invoice jobs cannot publish a quote.", {
      field_errors: [{ field: "mode", message: "Direct invoice jobs cannot publish a quote." }],
    });
  }
  if (code === "P0007") {
    return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "This job cannot publish a quote.");
  }
  if (code === "P0008") {
    return sendFail(
      request,
      reply,
      API_ERROR_CODES.PREVIEW_CHANGED,
      "This preview is out of date. Review the quote again before publishing.",
    );
  }
  if (code === "P0009") {
    return sendFail(
      request,
      reply,
      API_ERROR_CODES.ENTITLEMENT_REQUIRED,
      "You have used the three free published jobs. The draft was not published.",
    );
  }
  if (code === "P0010") {
    return sendFail(
      request,
      reply,
      API_ERROR_CODES.DOCUMENT_IMMUTABLE,
      "This quote is already published.",
    );
  }
  if (code === "23514" || code === "22023") {
    return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.");
  }
  return undefined;
}

export function registerQuotePublishRoutes(
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
      owner = await withApiRole(deps.pool, async (client) => {
        const result = await client.query<ProvisionRow>(
          `select actor_id, workspace_id, account_status, display_email, setup_completed, first_sign_in, analytics_alias_id, workspace_version
           from identity.provision_owner($1::uuid, $2, $3)`,
          [access.sub, parsedEmail.display, parsedEmail.normalized],
        );
        return result.rows[0];
      });
    } catch {
      sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
      return undefined;
    }
    if (!owner) {
      sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      return undefined;
    }
    if (owner.account_status === "suspended") {
      sendFail(request, reply, API_ERROR_CODES.ACCOUNT_SUSPENDED, "This account cannot make changes.");
      return undefined;
    }
    if (owner.account_status !== "active") {
      sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
      return undefined;
    }
    if (!owner.setup_completed) {
      sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      return undefined;
    }
    return owner;
  }

  app.post("/v1/drafts/:draftId/preview", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
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
    if (request.body !== undefined && request.body !== null && request.body !== "") {
      if (typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body as object).length > 0) {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
          field_errors: [{ field: "body", message: "Unknown fields are not allowed." }],
        });
      }
    }
    try {
      const frozen = await withApiRole(deps.pool, async (client) => {
        await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [
          owner.workspace_id,
          owner.actor_id,
        ]);
        const loaded = await client.query<PreviewContext>(
          `select d.id as draft_id, d.job_id, d.version, d.payload_json, w.default_tax_bp, w.timezone,
                  w.business_name, w.legal_name, w.contact_name, w.contact_email, w.contact_phone, w.address_json,
                  c.name as customer_name, c.email as customer_email, c.phone as customer_phone, c.billing_address_json,
                  j.title, j.site_address_json, j.no_site
           from commercial.document_drafts d
           join commercial.jobs j on j.workspace_id = d.workspace_id and j.id = d.job_id
           join commercial.customers c on c.workspace_id = j.workspace_id and c.id = j.customer_id
           join commercial.workspaces w on w.workspace_id = d.workspace_id
           where d.id = $1 and d.kind = 'quote'`,
          [params.draftId],
        );
        const ctx = loaded.rows[0];
        if (!ctx) {
          return { kind: "missing" as const };
        }
        const payload = payloadFromJson(ctx.payload_json);
        const parsed = parseDraftPayload(payload);
        if (!parsed.ok) {
          return { kind: "invalid" as const, field_errors: parsed.field_errors };
        }
        let built;
        try {
          built = buildFrozenSnapshot(ctx, parsed.value);
        } catch (error) {
          return { kind: "domain" as const, error };
        }
        const bytes = canonicalizeToBytes(built.snapshot);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
        const stored = await client.query<{
          id: string;
          version: number;
          preview_hash: string;
          preview_expires_at: Date | string;
          snapshot_json: QuoteSnapshotV1;
        }>(
          `select id, version, preview_hash, preview_expires_at, snapshot_json
           from commercial.freeze_quote_preview(
             $1::uuid, $2::uuid, $3::integer, $4, $5::bytea, $6::jsonb, $7::timestamptz
           )`,
          [
            owner.actor_id,
            params.draftId,
            expectedVersion,
            hash,
            Buffer.from(bytes),
            JSON.stringify(built.snapshot),
            expiresAt.toISOString(),
          ],
        );
        return { kind: "ok" as const, row: stored.rows[0], snapshot: built.snapshot, hash };
      });
      if (frozen.kind === "missing") {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, DRAFT_NOT_FOUND);
      }
      if (frozen.kind === "invalid") {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
          field_errors: frozen.field_errors,
        });
      }
      if (frozen.kind === "domain") {
        if (isDomainError(frozen.error)) {
          return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, frozen.error.message, {
            field_errors: frozen.error.field ? [{ field: frozen.error.field, message: frozen.error.message }] : [],
          });
        }
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Add at least one valid line item.");
      }
      if (!frozen.row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, DRAFT_NOT_FOUND);
      }
      return success(request.id, {
        draft_id: frozen.row.id,
        job_id: frozen.snapshot.job.id,
        version: frozen.row.version,
        preview_hash: frozen.hash,
        preview_expires_at: asIso(frozen.row.preview_expires_at),
        schema_version: frozen.snapshot.schema_version,
        number_label: "Draft",
        snapshot: frozen.snapshot,
      });
    } catch (error) {
      const mapped = mapPublishError(request, reply, error, DRAFT_NOT_FOUND);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.post("/v1/drafts/:draftId/publish", async (request, reply) => {
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
    const parsed = parseQuotePublish(request.body ?? {});
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
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
    const hash = requestHash({
      draftId: params.draftId,
      preview_hash: parsed.value.preview_hash,
      expectedVersion,
    });
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
        const published = await client.query<PublishRow>(
          `select id, workspace_id, job_id, draft_id, kind, number, revision_no, lifecycle, issued_at, issue_date,
                  currency, net_cents, tax_cents, total_cents, snapshot_json, schema_version, snapshot_sha256, pdf_state, replayed
           from commercial.publish_quote_draft(
             $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::integer, $7
           )`,
          [
            provisioned.actor_id,
            key,
            hash,
            request.id,
            params.draftId,
            expectedVersion,
            parsed.value.preview_hash,
          ],
        );
        return { kind: "ok" as const, row: published.rows[0] };
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
      return reply.status(202).send(success(request.id, presentPublishedQuote(row.row)));
    } catch (error) {
      const mapped = mapPublishError(request, reply, error, DRAFT_NOT_FOUND);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.get("/v1/documents/:documentId", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    const params = request.params as { documentId?: string };
    if (!isClientUuid(params.documentId)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "documentId", message: "A document UUID is required." }],
      });
    }
    try {
      const row = await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        const result = await client.query<PublishRow & { pdf_ready: boolean }>(
          `select d.id, d.workspace_id, d.job_id, dr.id as draft_id, d.kind, d.number, d.revision_no, d.lifecycle,
                  d.issued_at, d.issue_date, d.currency, d.net_cents, d.tax_cents, d.total_cents, d.snapshot_json,
                  d.schema_version, d.snapshot_sha256,
                  case when a.id is null then 'preparing' else a.state end as pdf_state
           from commercial.documents d
           left join commercial.document_drafts dr
             on dr.workspace_id = d.workspace_id and dr.parent_document_id = d.id and dr.kind = 'quote'
           left join commercial.artifacts a
             on a.workspace_id = d.workspace_id and a.document_id = d.id and a.type = 'original_pdf'
           where d.id = $1 and d.kind = 'quote'`,
          [params.documentId],
        );
        return result.rows[0];
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, DOCUMENT_NOT_FOUND);
      }
      return success(request.id, presentPublishedQuote(row));
    } catch {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.get("/v1/documents/:documentId/download", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    const params = request.params as { documentId?: string };
    if (!isClientUuid(params.documentId)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "documentId", message: "A document UUID is required." }],
      });
    }
    try {
      const row = await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        const document = await client.query<{ id: string }>(
          `select id from commercial.documents where id = $1 and kind = 'quote'`,
          [params.documentId],
        );
        if (!document.rows[0]) {
          return undefined;
        }
        const artifact = await client.query<{ state: string }>(
          `select state from commercial.artifacts
           where document_id = $1 and type = 'original_pdf'`,
          [params.documentId],
        );
        return { document_id: document.rows[0].id, state: artifact.rows[0]?.state ?? "preparing" };
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, DOCUMENT_NOT_FOUND);
      }
      return success(request.id, {
        document_id: row.document_id,
        state: row.state,
        url: null,
      });
    } catch {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });
}
