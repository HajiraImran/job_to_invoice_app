import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import {
  encodeFragmentToken,
  encryptDeliveryToken,
  encryptRecipientEmail,
  encryptUtf8,
  generateApprovalToken,
  hashApprovalToken,
  parseVersionedSecret,
} from "@job-to-invoice/config";
import {
  buildCreditSnapshot,
  buildInvoiceSnapshot,
  calculateCredit,
  calculateInvoiceFromResiduals,
  canonicalizeToBytes,
  deriveLedger,
  emptyLedger,
  isDomainError,
  remainingAfterReductions,
  type CreditSnapshotV1,
  type InvoiceSnapshotV1,
  type LedgerState,
  type QuoteSnapshotV1,
} from "@job-to-invoice/domain";
import {
  addCalendarDays,
  API_ERROR_CODES,
  isClientUuid,
  parseCreditIssue,
  parseCreditPreview,
  parseInvoiceIssue,
  parseInvoicePreview,
  parseInvoiceReplacementPreview,
  parseInvoiceVoid,
  parseLedgerPayment,
  parseLedgerRefund,
  parseLedgerReverse,
  parseOwnerEmail,
  PREVIEW_TTL_MS,
  unresolvedInvoiceFieldErrors,
  unresolvedInvoiceMessage,
  zonedCalendarDate,
  type InvoiceUnresolvedBlocker,
} from "@job-to-invoice/schemas";
import type { Pool } from "pg";
import { withApiRole } from "./db.ts";
import { fail, success } from "./envelope.ts";
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

type IssueRow = {
  id: string;
  workspace_id: string;
  job_id: string;
  draft_id: string | null;
  kind: string;
  number: string;
  revision_no: number;
  lifecycle: string;
  issued_at: Date | string;
  issue_date: Date | string;
  due_date: Date | string | null;
  currency: string;
  net_cents: string | number;
  tax_cents: string | number;
  total_cents: string | number;
  snapshot_json: InvoiceSnapshotV1 | CreditSnapshotV1;
  schema_version: number;
  snapshot_sha256: string;
  pdf_state: string;
  request_id?: string;
  delivery_state?: string;
  void_reason?: string | null;
  replayed?: boolean;
};

type ResidualLineRow = {
  source_line_id: string;
  position: number;
  description: string;
  quantity: string | number | null;
  unit: string | null;
  unit_price_cents: string | number | null;
  discount_cents: string | number;
  tax_bp: number;
  residual_net_cents: string | number;
  residual_tax_cents: string | number;
};

type QuoteContext = {
  job_id: string;
  lifecycle: string;
  mode: string;
  title: string;
  site_address_json: unknown;
  no_site: boolean;
  current_quote_id: string | null;
  quote_id: string | null;
  quote_number: string | null;
  quote_lifecycle: string | null;
  quote_snapshot: QuoteSnapshotV1 | null;
  timezone: string;
  default_due_days: number;
  default_terms: string;
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

const INVOICE_UNRESOLVED_SQL = `select 'change_draft'::text as kind, null::text as document_kind, null::text as number, null::int as revision_no
           from commercial.document_drafts
          where workspace_id = $1 and job_id = $2 and kind = 'change' and draft_state = 'editing'
            and commercial.change_draft_is_invoice_blocker(workspace_id, job_id, payload_json)
         union all
         select 'pending_approval', d.kind, d.number, d.revision_no
           from commercial.documents d
          where d.workspace_id = $1 and d.job_id = $2
            and d.kind in ('quote', 'change')
            and d.lifecycle = 'issued'`;

async function loadInvoiceUnresolvedBlockers(
  pool: Pool,
  workspaceId: string,
  actorId: string,
  jobId: string,
): Promise<InvoiceUnresolvedBlocker[]> {
  return withApiRole(pool, async (client) => {
    await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [workspaceId, actorId]);
    const found = await client.query<InvoiceUnresolvedBlocker>(INVOICE_UNRESOLVED_SQL, [workspaceId, jobId]);
    return found.rows;
  });
}

async function sendUnresolvedInvoice(
  request: FastifyRequest,
  reply: FastifyReply,
  pool: Pool,
  owner: { workspace_id: string; actor_id: string },
  jobId: string,
) {
  let blockers: InvoiceUnresolvedBlocker[];
  try {
    blockers = await loadInvoiceUnresolvedBlockers(pool, owner.workspace_id, owner.actor_id, jobId);
  } catch {
    blockers = [];
  }
  return sendFail(request, reply, API_ERROR_CODES.UNRESOLVED_CHANGES, unresolvedInvoiceMessage(blockers), {
    field_errors: unresolvedInvoiceFieldErrors(blockers),
  });
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

function envSecret(env: Record<string, unknown>, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function overlayReplacementSnapshot(
  source: InvoiceSnapshotV1,
  overlay: {
    due_date?: string;
    payment_instructions?: string;
    customer?: {
      name?: string;
      email?: string;
      phone?: string | null;
      billing_address?: InvoiceSnapshotV1["customer"]["billing_address"];
    };
  },
  issueDate: string,
): InvoiceSnapshotV1 {
  const dueDate = overlay.due_date ?? (source.due_date < issueDate ? issueDate : source.due_date);
  return {
    ...source,
    issue_date: issueDate,
    due_date: dueDate,
    payment_instructions: overlay.payment_instructions ?? source.payment_instructions,
    customer: {
      ...source.customer,
      name: overlay.customer?.name ?? source.customer.name,
      email: overlay.customer?.email !== undefined ? overlay.customer.email : source.customer.email,
      phone: overlay.customer?.phone !== undefined ? overlay.customer.phone : source.customer.phone,
      billing_address:
        overlay.customer?.billing_address !== undefined
          ? overlay.customer.billing_address
          : source.customer.billing_address,
    },
  };
}

function resolveApprovalSecrets(env: Record<string, unknown>) {
  try {
    const hashKey = envSecret(env, "APPROVAL_TOKEN_HASH_KEY");
    const deliveryKey = envSecret(env, "APPROVAL_DELIVERY_ENCRYPTION_KEY");
    if (!hashKey || !deliveryKey) {
      return undefined;
    }
    return {
      hash: parseVersionedSecret("APPROVAL_TOKEN_HASH_KEY", hashKey),
      delivery: parseVersionedSecret("APPROVAL_DELIVERY_ENCRYPTION_KEY", deliveryKey),
    };
  } catch {
    return undefined;
  }
}

export type CreditSource = {
  invoice_line_id: string;
  description: string;
  residual_net_cents: number;
  residual_tax_cents: number;
  credited_net_cents: number;
  remaining_net_cents: number;
};

type LedgerEntryDb = {
  id: string;
  type: "payment" | "refund" | "reversal";
  amount_cents: string | number;
  reverses_entry_id: string | null;
  effective_date: Date | string;
  method: string | null;
  reference: string | null;
  note: string | null;
};

export async function loadInvoiceLedgerState(
  client: PoolClient,
  workspaceId: string,
  invoiceId: string,
  invoiceIssuedCents: number,
  dueDate: string | null,
  voided = false,
): Promise<{ state: LedgerState; entries: LedgerEntryDb[]; credit_sources: CreditSource[] }> {
  const entries = await client.query<LedgerEntryDb>(
    `select id, type, amount_cents, reverses_entry_id, effective_date, method, reference, note
     from commercial.ledger_entries
     where workspace_id = $1 and invoice_id = $2
     order by created_at, id`,
    [workspaceId, invoiceId],
  );
  const allocations = await client.query<{
    refund_entry_id: string;
    payment_entry_id: string;
    amount_cents: string | number;
  }>(
    `select a.refund_entry_id, a.payment_entry_id, a.amount_cents
     from commercial.ledger_refund_allocations a
     join commercial.ledger_entries e
       on e.workspace_id = a.workspace_id and e.id = a.refund_entry_id
     where a.workspace_id = $1 and e.invoice_id = $2`,
    [workspaceId, invoiceId],
  );
  const credits = await client.query<{ credits_cents: string | number }>(
    `select coalesce(sum(d.total_cents), 0) as credits_cents
     from commercial.documents d
     where d.workspace_id = $1
       and d.kind = 'credit'
       and d.lifecycle = 'issued'
       and d.prior_document_id = $2`,
    [workspaceId, invoiceId],
  );
  const sources = await client.query<{
    invoice_line_id: string;
    description: string;
    residual_net_cents: string | number;
    residual_tax_cents: string | number;
    credited_net_cents: string | number;
  }>(
    `select dl.id as invoice_line_id,
            dl.description,
            dl.net_cents as residual_net_cents,
            dl.tax_cents as residual_tax_cents,
            coalesce(sum(ca.net_credit_cents), 0) as credited_net_cents
     from commercial.document_lines dl
     left join commercial.credit_allocations ca
       on ca.workspace_id = dl.workspace_id and ca.invoice_line_id = dl.id
     where dl.workspace_id = $1 and dl.document_id = $2
     group by dl.id
     order by dl.position, dl.id`,
    [workspaceId, invoiceId],
  );
  return {
    state: {
      invoice_issued_cents: invoiceIssuedCents,
      credits_cents: asCents(credits.rows[0]?.credits_cents ?? 0),
      entries: entries.rows.map((entry) => ({
        entry_id: entry.id,
        type: entry.type,
        amount_cents: asCents(entry.amount_cents),
        reverses_entry_id: entry.reverses_entry_id,
      })),
      allocations: allocations.rows.map((allocation) => ({
        refund_entry_id: allocation.refund_entry_id,
        payment_entry_id: allocation.payment_entry_id,
        amount_cents: asCents(allocation.amount_cents),
      })),
      voided,
      due_date: dueDate,
      agreed_job_total_cents: invoiceIssuedCents,
    },
    entries: entries.rows,
    credit_sources: sources.rows.map((row) => {
      const residualNet = asCents(row.residual_net_cents);
      const residualTax = asCents(row.residual_tax_cents);
      const credited = asCents(row.credited_net_cents);
      const remaining =
        credited === 0
          ? { remainingNet: BigInt(residualNet) }
          : remainingAfterReductions(BigInt(residualNet), BigInt(residualTax), [BigInt(credited)]);
      return {
        invoice_line_id: row.invoice_line_id,
        description: row.description,
        residual_net_cents: residualNet,
        residual_tax_cents: residualTax,
        credited_net_cents: credited,
        remaining_net_cents: Number(remaining.remainingNet),
      };
    }),
  };
}

function presentLedgerEntries(entries: LedgerEntryDb[]) {
  return entries.map((entry) => ({
    id: entry.id,
    type: entry.type,
    amount_cents: asCents(entry.amount_cents),
    effective_date: asDate(entry.effective_date),
    method: entry.method,
    reverses_entry_id: entry.reverses_entry_id,
  }));
}

export function presentIssuedInvoice(
  row: IssueRow,
  pdfState = row.pdf_state,
  ledger?: { state: LedgerState; entries: LedgerEntryDb[]; credit_sources?: CreditSource[] },
) {
  const snapshot = row.snapshot_json;
  const dueDate = row.due_date ? asDate(row.due_date) : snapshot.kind === "invoice" ? snapshot.due_date : asDate(row.issue_date);
  const today = snapshot.business.timezone ? zonedCalendarDate(new Date(), snapshot.business.timezone) : dueDate;
  const state =
    ledger?.state ??
    emptyLedger({
      invoice_issued_cents: asCents(row.total_cents),
      due_date: dueDate,
      agreed_job_total_cents: asCents(row.total_cents),
    });
  const derived = deriveLedger(state, { as_of_date: today });
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
    due_date: dueDate,
    currency: row.currency,
    schema_version: row.schema_version,
    snapshot_sha256: row.snapshot_sha256,
    preview_hash: row.snapshot_sha256,
    pdf_state: pdfState,
    request_id: row.request_id ?? null,
    delivery_state: row.delivery_state ?? null,
    payment_status: derived.payment_status,
    settled_by: derived.settled_by,
    credits_cents: derived.credits_cents,
    effective_payments_cents: derived.effective_payments_cents,
    effective_refunds_cents: derived.effective_refunds_cents,
    net_received_cents: derived.net_received_cents,
    balance_cents: derived.balance_cents,
    amount_due_cents: derived.amount_due_cents,
    amount_to_refund_cents: derived.amount_to_refund_cents,
    recorded_by: "Recorded by business",
    entries: presentLedgerEntries(ledger?.entries ?? []),
    credit_sources: ledger?.credit_sources ?? [],
    snapshot,
    net_cents: asCents(row.net_cents),
    tax_cents: asCents(row.tax_cents),
    total_cents: asCents(row.total_cents),
    voided: row.lifecycle === "voided",
    void_reason: row.void_reason ?? null,
  };
}

export function mapInvoiceError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): ReturnType<typeof sendFail> | undefined {
  const code = pgCode(error);
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
    return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, JOB_NOT_FOUND);
  }
  if (code === "P0006") {
    return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Direct invoice jobs cannot use this quote invoice path.");
  }
  if (code === "P0008") {
    return sendFail(
      request,
      reply,
      API_ERROR_CODES.PREVIEW_CHANGED,
      "This preview is out of date. Review the invoice again before issuing.",
    );
  }
  if (code === "P0009") {
    return sendFail(request, reply, API_ERROR_CODES.ENTITLEMENT_REQUIRED, "This job cannot be invoiced.");
  }
  if (code === "P0043") {
    return sendFail(
      request,
      reply,
      API_ERROR_CODES.UNRESOLVED_CHANGES,
      unresolvedInvoiceMessage([]),
    );
  }
  if (code === "P0044") {
    return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "This job cannot be invoiced yet.");
  }
  if (code === "P0045") {
    return sendFail(
      request,
      reply,
      API_ERROR_CODES.SCOPE_CHANGED,
      "Accepted scope changed. Review the invoice again before issuing.",
    );
  }
  if (code === "P0046") {
    return sendFail(
      request,
      reply,
      API_ERROR_CODES.REFUND_EXCEEDS_BALANCE,
      "That refund is more than the refundable amount.",
    );
  }
  if (code === "P0047") {
    return sendFail(
      request,
      reply,
      API_ERROR_CODES.CREDIT_EXCEEDS_SOURCE,
      "That credit is more than the remaining amount on the invoice line.",
    );
  }
  if (code === "P0048") {
    return sendFail(
      request,
      reply,
      API_ERROR_CODES.ENTRY_ALREADY_REVERSED,
      "This entry is already reversed.",
    );
  }
  if (code === "P0049") {
    return sendFail(
      request,
      reply,
      API_ERROR_CODES.VALIDATION_FAILED,
      "Reverse dependent refunds before reversing this payment.",
      { field_errors: [{ field: "reverses_entry_id", message: "Reverse dependent refunds first." }] },
    );
  }
  if (code === "P0050") {
    return sendFail(
      request,
      reply,
      API_ERROR_CODES.LEDGER_BLOCKS_VOID,
      "This invoice cannot be voided while a payment, refund, or issued credit remains.",
    );
  }
  if (code === "23001") {
    return sendFail(request, reply, API_ERROR_CODES.DOCUMENT_IMMUTABLE, "This invoice cannot be changed.");
  }
  if (code === "23505") {
    return sendFail(request, reply, API_ERROR_CODES.DOCUMENT_IMMUTABLE, "This job already has an issued invoice.");
  }
  if (code === "23514" || code === "22023") {
    return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.");
  }
  return undefined;
}

export function registerInvoiceRoutes(
  app: FastifyInstance,
  deps: {
    env?: Record<string, unknown>;
    verifyJwt?: JwtVerifier;
    pool?: Pool;
  },
  options: { limiterAllow: (key: string) => { ok: true } | { ok: false; retryAfterSec: number } },
) {
  async function requireOwner(request: FastifyRequest, reply: FastifyReply): Promise<ProvisionRow | undefined> {
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

  app.post("/v1/jobs/:jobId/invoice-preview", async (request, reply) => {
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
    const parsed = parseInvoicePreview(request.body ?? {});
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    try {
      const frozen = await withApiRole(deps.pool, async (client) => {
        await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [
          owner.workspace_id,
          owner.actor_id,
        ]);
        const loaded = await client.query<QuoteContext>(
          `select j.id as job_id, j.lifecycle, j.mode, j.title, j.site_address_json, j.no_site,
                  j.current_quote_id, q.id as quote_id, q.number as quote_number, q.lifecycle as quote_lifecycle,
                  q.snapshot_json as quote_snapshot, w.timezone, w.default_due_days, w.default_terms,
                  w.business_name, w.legal_name, w.contact_name, w.contact_email, w.contact_phone, w.address_json,
                  c.name as customer_name, c.email as customer_email, c.phone as customer_phone, c.billing_address_json
           from commercial.jobs j
           join commercial.customers c on c.workspace_id = j.workspace_id and c.id = j.customer_id
           join commercial.workspaces w on w.workspace_id = j.workspace_id
           left join commercial.documents q on q.workspace_id = j.workspace_id and q.id = j.current_quote_id
           where j.id = $1`,
          [params.jobId],
        );
        const ctx = loaded.rows[0];
        if (!ctx) {
          return { kind: "missing" as const };
        }
        if (!ctx.quote_id || !ctx.quote_snapshot || ctx.quote_lifecycle !== "accepted") {
          return { kind: "ineligible" as const };
        }
        const residuals = await client.query<ResidualLineRow>(
          `select dl.id as source_line_id,
                  row_number() over (order by min(origin.scope_version), dl.position, dl.id)::int as position,
                  dl.description, dl.quantity, dl.unit,
                  dl.unit_price_cents, dl.discount_cents, dl.tax_bp,
                  coalesce(sum(se.net_delta_cents), 0) as residual_net_cents,
                  coalesce(sum(se.tax_delta_cents), 0) as residual_tax_cents
           from commercial.document_lines dl
           join commercial.scope_entries origin
             on origin.workspace_id = dl.workspace_id
            and origin.source_line_id = dl.id
            and origin.event_kind = 'add'
            and origin.job_id = $2
           left join commercial.scope_entries se
             on se.workspace_id = dl.workspace_id and se.source_line_id = dl.id
           where dl.workspace_id = $1
           group by dl.id
           order by min(origin.scope_version), dl.position, dl.id`,
          [owner.workspace_id, params.jobId],
        );
        if (residuals.rows.length < 1) {
          return { kind: "ineligible" as const };
        }
        const recipient = await client.query<{ approved_quote_recipient: string | null }>(
          "select commercial.approved_quote_recipient($1::uuid, $2::uuid) as approved_quote_recipient",
          [owner.actor_id, params.jobId],
        );
        let totals;
        try {
          totals = calculateInvoiceFromResiduals(
            residuals.rows.map((row) => ({
              source_line_id: row.source_line_id,
              residual_net_cents: asCents(row.residual_net_cents),
              residual_tax_cents: asCents(row.residual_tax_cents),
            })),
            { agreed_job_total_cents: residuals.rows.reduce((sum, row) => sum + asCents(row.residual_net_cents) + asCents(row.residual_tax_cents), 0) },
          );
        } catch (error) {
          return { kind: "domain" as const, error };
        }
        const quote = ctx.quote_snapshot;
        const issueDate = zonedCalendarDate(new Date(), ctx.timezone);
        const dueDate = parsed.value.due_date ?? addCalendarDays(issueDate, ctx.default_due_days);
        if (dueDate < issueDate) {
          return {
            kind: "invalid" as const,
            field_errors: [{ field: "due_date", message: "Due date cannot be before the issue date." }],
          };
        }
        if (dueDate > addCalendarDays(issueDate, 365)) {
          return {
            kind: "invalid" as const,
            field_errors: [{ field: "due_date", message: "Due date cannot be more than 365 days after issue." }],
          };
        }
        const customerEmail =
          quote.customer.email || recipient.rows[0]?.approved_quote_recipient || ctx.customer_email;
        if (!customerEmail) {
          return {
            kind: "invalid" as const,
            field_errors: [{ field: "customer.email", message: "A customer email is required to send the invoice." }],
          };
        }
        const taxByRate = new Map<number, { net_cents: number; tax_cents: number }>();
        const lines = [];
        for (const [index, row] of residuals.rows.entries()) {
          const money = totals.lines[index];
          if (!money) {
            return { kind: "ineligible" as const };
          }
          const quoteLine = quote.lines.find((item) => item.position === row.position);
          const taxBp = row.tax_bp;
          const grouped = taxByRate.get(taxBp) ?? { net_cents: 0, tax_cents: 0 };
          grouped.net_cents += money.net_cents;
          grouped.tax_cents += money.tax_cents;
          taxByRate.set(taxBp, grouped);
          const gross =
            asCents(row.unit_price_cents ?? 0) && quoteLine
              ? quoteLine.gross_cents
              : money.net_cents + asCents(row.discount_cents);
          lines.push({
            position: row.position,
            source_line_id: row.source_line_id,
            description: row.description,
            unit: row.unit ?? quoteLine?.unit ?? "item",
            custom_unit_label: quoteLine?.custom_unit_label ?? null,
            quantity: row.quantity == null ? (quoteLine?.quantity ?? "1") : String(row.quantity),
            unit_price_cents: row.unit_price_cents == null ? (quoteLine?.unit_price_cents ?? 0) : asCents(row.unit_price_cents),
            discount_cents: asCents(row.discount_cents),
            tax_bp: taxBp,
            gross_cents: quoteLine?.gross_cents ?? gross,
            net_cents: money.net_cents,
            tax_cents: money.tax_cents,
            total_cents: money.total_cents,
          });
        }
        const snapshot = buildInvoiceSnapshot({
          business: quote.business,
          customer: { ...quote.customer, email: customerEmail },
          job: quote.job,
          notes: quote.notes,
          payment_instructions: parsed.value.payment_instructions ?? ctx.default_terms ?? "",
          issue_date: issueDate,
          due_date: dueDate,
          source_quote_id: ctx.quote_id,
          source_quote_number: ctx.quote_number ?? "",
          lines,
          net_cents: totals.net_cents,
          tax_cents: totals.tax_cents,
          total_cents: totals.total_cents,
          tax_by_rate: [...taxByRate.entries()].map(([tax_bp, amounts]) => ({ tax_bp, ...amounts })),
        });
        const bytes = canonicalizeToBytes(snapshot);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
        const stored = await client.query<{
          id: string;
          version: number;
          preview_hash: string;
          preview_expires_at: Date | string;
          snapshot_json: InvoiceSnapshotV1;
        }>(
          `select id, version, preview_hash, preview_expires_at, snapshot_json
           from commercial.freeze_invoice_preview(
             $1::uuid, $2::uuid, $3, $4::bytea, $5::jsonb, $6::timestamptz
           )`,
          [owner.actor_id, params.jobId, hash, Buffer.from(bytes), JSON.stringify(snapshot), expiresAt.toISOString()],
        );
        return { kind: "ok" as const, row: stored.rows[0], snapshot, hash };
      });
      if (frozen.kind === "missing") {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, JOB_NOT_FOUND);
      }
      if (frozen.kind === "ineligible") {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "This job cannot be invoiced yet.");
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
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "This job cannot be invoiced yet.");
      }
      if (!frozen.row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, JOB_NOT_FOUND);
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
      if (pgCode(error) === "P0043" && deps.pool && params.jobId) {
        return sendUnresolvedInvoice(request, reply, deps.pool, owner, params.jobId);
      }
      const mapped = mapInvoiceError(request, reply, error);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.post("/v1/jobs/:jobId/issue-invoice", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_REQUIRED, SIGN_IN_REQUIRED);
    }
    if (!deps.verifyJwt || !deps.pool) {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
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
    const parsed = parseInvoiceIssue(request.body ?? {});
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    const secrets = resolveApprovalSecrets(deps.env ?? {});
    const hash = requestHash({
      jobId: params.jobId,
      preview_hash: parsed.value.preview_hash,
    });
    const approvalToken = generateApprovalToken();
    try {
      let tokenHash: string | null = null;
      let tokenKeyVersion: number | null = null;
      let ciphertext: Buffer | null = null;
      let nonce: Buffer | null = null;
      let algorithm: string | null = null;
      let deliveryKeyVersion: number | null = null;
      let encryptedEmail: Buffer | null = null;
      const issued = await withApiRole(deps.pool, async (client) => {
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
        const jobMode = await client.query<{ mode: string }>(
          "select mode from commercial.jobs where id = $1",
          [params.jobId],
        );
        if (!jobMode.rows[0]) {
          return { kind: "missing" as const };
        }
        const preview = await client.query<{ recipient: string | null }>(
          `select recipient
           from (
             select 1 as rank, d.preview_snapshot_json#>>'{customer,email}' as recipient
             from commercial.document_drafts d
             where d.job_id = $1 and d.kind = 'invoice' and d.draft_state = 'editing'
             union all
             select 2, doc.snapshot_json#>>'{customer,email}'
             from commercial.documents doc
             where doc.job_id = $1 and doc.kind = 'invoice' and doc.lifecycle is distinct from 'voided'
           ) s
           where nullif(btrim(recipient), '') is not null
           order by rank
           limit 1`,
          [params.jobId],
        );
        const recipient = preview.rows[0]?.recipient;
        const isDirect = jobMode.rows[0].mode === "direct_invoice";
        if (!isDirect && !recipient) {
          return { kind: "preview" as const };
        }
        if (recipient) {
          if (!secrets) {
            return { kind: "unavailable" as const };
          }
          const parsedRecipient = parseOwnerEmail(recipient);
          if (!parsedRecipient.ok) {
            return { kind: "preview" as const };
          }
          encodeFragmentToken(approvalToken);
          const hashed = hashApprovalToken(approvalToken, secrets.hash);
          tokenHash = hashed.hash;
          tokenKeyVersion = hashed.keyVersion;
          const encrypted = encryptDeliveryToken(approvalToken, secrets.delivery);
          ciphertext = encrypted.ciphertext;
          nonce = encrypted.nonce;
          algorithm = encrypted.algorithm;
          deliveryKeyVersion = encrypted.keyVersion;
          const packedEmail = encryptRecipientEmail(parsedRecipient.display, secrets.delivery);
          encryptedEmail = Buffer.concat([packedEmail.nonce, packedEmail.ciphertext]);
        }
        const accessUntil = recipient ? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) : null;
        const issueSql = isDirect
          ? `select id, workspace_id, job_id, draft_id, kind, number, revision_no, lifecycle, issued_at, issue_date, due_date,
                  currency, net_cents, tax_cents, total_cents, snapshot_json, schema_version, snapshot_sha256, pdf_state,
                  request_id, delivery_state, replayed
           from commercial.issue_direct_invoice(
             $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6,
             $7, $8::integer, $9::bytea, $10::bytea, $11::bytea, $12, $13::integer, $14::timestamptz
           )`
          : `select id, workspace_id, job_id, draft_id, kind, number, revision_no, lifecycle, issued_at, issue_date, due_date,
                  currency, net_cents, tax_cents, total_cents, snapshot_json, schema_version, snapshot_sha256, pdf_state,
                  request_id, delivery_state, replayed
           from commercial.issue_invoice(
             $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6,
             $7, $8::integer, $9::bytea, $10::bytea, $11::bytea, $12, $13::integer, $14::timestamptz
           )`;
        const row = await client.query<IssueRow>(issueSql, [
          provisioned.actor_id,
          key,
          hash,
          request.id,
          params.jobId,
          parsed.value.preview_hash,
          tokenHash,
          tokenKeyVersion,
          encryptedEmail,
          ciphertext,
          nonce,
          algorithm,
          deliveryKeyVersion,
          accessUntil?.toISOString() ?? null,
        ]);
        return { kind: "ok" as const, row: row.rows[0] };
      });
      if (!issued) {
        return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      }
      if (issued.kind === "suspended") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_SUSPENDED, "This account cannot make changes.");
      }
      if (issued.kind === "locked") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
      }
      if (issued.kind === "setup") {
        return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      }
      if (issued.kind === "missing") {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, JOB_NOT_FOUND);
      }
      if (issued.kind === "unavailable") {
        return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
      }
      if (issued.kind === "preview") {
        return sendFail(
          request,
          reply,
          API_ERROR_CODES.PREVIEW_CHANGED,
          "This preview is out of date. Review the invoice again before issuing.",
        );
      }
      if (!issued.row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, JOB_NOT_FOUND);
      }
      return reply.status(202).send(success(request.id, presentIssuedInvoice(issued.row)));
    } catch (error) {
      if (pgCode(error) === "P0043" && deps.pool && params.jobId) {
        const provisioned = await withApiRole(deps.pool, async (client) => {
          const loaded = await client.query<ProvisionRow>(
            `select actor_id, workspace_id, account_status, display_email, setup_completed, first_sign_in, analytics_alias_id, workspace_version
             from identity.provision_owner($1::uuid, $2, $3)`,
            [access.sub, parsedEmail.display, parsedEmail.normalized],
          );
          return loaded.rows[0];
        });
        if (provisioned) {
          return sendUnresolvedInvoice(request, reply, deps.pool, provisioned, params.jobId);
        }
      }
      const mapped = mapInvoiceError(request, reply, error);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    } finally {
      approvalToken.fill(0);
    }
  });

  const INVOICE_NOT_FOUND = "Invoice was not found.";

  type LedgerCommandRow = {
    id: string;
    invoice_id: string;
    job_id: string;
    type: string;
    amount_cents: string | number;
    effective_date: Date | string;
    method: string | null;
    reference: string | null;
    note: string | null;
    payment_status: string;
    invoice_issued_cents: string | number;
    credits_cents: string | number;
    effective_payments_cents: string | number;
    effective_refunds_cents: string | number;
    net_received_cents: string | number;
    balance_cents: string | number;
    amount_due_cents: string | number;
    amount_to_refund_cents: string | number;
    settlement: string | null;
    replayed: boolean;
    reverses_entry_id?: string | null;
  };

  function presentLedgerCommand(row: LedgerCommandRow) {
    return {
      id: row.id,
      invoice_id: row.invoice_id,
      job_id: row.job_id,
      type: row.type,
      amount_cents: asCents(row.amount_cents),
      effective_date: asDate(row.effective_date),
      method: row.method,
      reference: row.reference,
      note: row.note,
      reverses_entry_id: row.reverses_entry_id ?? null,
      payment_status: row.payment_status,
      invoice_issued_cents: asCents(row.invoice_issued_cents),
      credits_cents: asCents(row.credits_cents),
      effective_payments_cents: asCents(row.effective_payments_cents),
      effective_refunds_cents: asCents(row.effective_refunds_cents),
      net_received_cents: asCents(row.net_received_cents),
      balance_cents: asCents(row.balance_cents),
      amount_due_cents: asCents(row.amount_due_cents),
      amount_to_refund_cents: asCents(row.amount_to_refund_cents),
      recorded_by: "Recorded by business",
      replayed: row.replayed,
    };
  }

  app.get("/v1/invoices/:invoiceId/ledger", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_REQUIRED, SIGN_IN_REQUIRED);
    }
    if (!deps.verifyJwt || !deps.pool) {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
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
    const params = request.params as { invoiceId?: string };
    if (!isClientUuid(params.invoiceId)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "invoiceId", message: "An invoice UUID is required." }],
      });
    }
    try {
      const loaded = await withApiRole(deps.pool, async (client) => {
        const owner = await client.query<ProvisionRow>(
          `select actor_id, workspace_id, account_status, display_email, setup_completed, first_sign_in, analytics_alias_id, workspace_version
           from identity.provision_owner($1::uuid, $2, $3)`,
          [access.sub, parsedEmail.display, parsedEmail.normalized],
        );
        const provisioned = owner.rows[0];
        if (!provisioned || provisioned.account_status !== "active" || !provisioned.setup_completed) {
          return provisioned;
        }
        await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [
          provisioned.workspace_id,
          provisioned.actor_id,
        ]);
        const invoice = await client.query<IssueRow>(
          `select d.id, d.workspace_id, d.job_id, null::uuid as draft_id, d.kind, d.number, d.revision_no, d.lifecycle,
                  d.issued_at, d.issue_date, d.due_date, d.currency, d.net_cents, d.tax_cents, d.total_cents,
                  d.snapshot_json, d.schema_version, d.snapshot_sha256, d.void_reason,
                  coalesce(p.download_state, 'preparing') as pdf_state
           from commercial.documents d
           left join lateral commercial.original_pdf_download($2::uuid, d.id) p on true
           where d.id = $1 and d.kind = 'invoice'`,
          [params.invoiceId, provisioned.workspace_id],
        );
        const row = invoice.rows[0];
        if (!row) {
          return { kind: "missing" as const };
        }
        const dueDate = row.due_date
          ? asDate(row.due_date)
          : row.snapshot_json.kind === "invoice"
            ? row.snapshot_json.due_date
            : asDate(row.issue_date);
        const ledger = await loadInvoiceLedgerState(
          client,
          provisioned.workspace_id,
          row.id,
          asCents(row.total_cents),
          dueDate,
          row.lifecycle === "voided",
        );
        return { kind: "ok" as const, presented: presentIssuedInvoice(row, row.pdf_state, ledger) };
      });
      if (!loaded || !("kind" in loaded)) {
        const status = loaded?.account_status;
        if (status === "suspended") {
          return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_SUSPENDED, "This account cannot make changes.");
        }
        if (status && status !== "active") {
          return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
        }
        if (loaded && loaded.setup_completed === false) {
          return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
        }
        return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      }
      if (loaded.kind === "missing") {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, INVOICE_NOT_FOUND);
      }
      return success(request.id, loaded.presented);
    } catch (error) {
      const mapped = mapInvoiceError(request, reply, error);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  async function runLedgerCommand(
    request: FastifyRequest,
    reply: FastifyReply,
    kind: "payment" | "refund",
  ) {
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_REQUIRED, SIGN_IN_REQUIRED);
    }
    if (!deps.verifyJwt || !deps.pool) {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
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
    const key = idempotencyKey(request);
    if (!key || !UUID.test(key)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Idempotency-Key UUID is required.", {
        field_errors: [{ field: "Idempotency-Key", message: "UUID required" }],
      });
    }
    const params = request.params as { invoiceId?: string };
    if (!isClientUuid(params.invoiceId)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "invoiceId", message: "An invoice UUID is required." }],
      });
    }
    const parsed =
      kind === "payment" ? parseLedgerPayment(request.body ?? {}) : parseLedgerRefund(request.body ?? {});
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    const hash = requestHash({ invoiceId: params.invoiceId, ...parsed.value });
    try {
      const recorded = await withApiRole(deps.pool, async (client) => {
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
        const sql =
          kind === "payment"
            ? `select * from commercial.record_invoice_payment(
                 $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::bigint, $7::date, $8, $9, $10, $11::boolean
               )`
            : `select * from commercial.record_invoice_refund(
                 $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::bigint, $7::date, $8, $9, $10
               )`;
        const args =
          kind === "payment"
            ? [
                provisioned.actor_id,
                key,
                hash,
                request.id,
                params.invoiceId,
                parsed.value.amount_cents,
                parsed.value.effective_date,
                parsed.value.method,
                "reference" in parsed.value ? parsed.value.reference ?? null : null,
                "note" in parsed.value ? parsed.value.note ?? null : null,
                "confirm_overpayment" in parsed.value ? parsed.value.confirm_overpayment : false,
              ]
            : [
                provisioned.actor_id,
                key,
                hash,
                request.id,
                params.invoiceId,
                parsed.value.amount_cents,
                parsed.value.effective_date,
                parsed.value.method,
                "reference" in parsed.value ? parsed.value.reference ?? null : null,
                "note" in parsed.value ? parsed.value.note ?? null : null,
              ];
        const row = await client.query<LedgerCommandRow>(sql, args);
        return { kind: "ok" as const, row: row.rows[0] };
      });
      if (!recorded) {
        return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      }
      if (recorded.kind === "suspended") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_SUSPENDED, "This account cannot make changes.");
      }
      if (recorded.kind === "locked") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
      }
      if (recorded.kind === "setup") {
        return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      }
      if (!recorded.row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, INVOICE_NOT_FOUND);
      }
      return success(request.id, presentLedgerCommand(recorded.row));
    } catch (error) {
      const mapped = mapInvoiceError(request, reply, error);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  }

  app.post("/v1/invoices/:invoiceId/payments", async (request, reply) => runLedgerCommand(request, reply, "payment"));
  app.post("/v1/invoices/:invoiceId/refunds", async (request, reply) => runLedgerCommand(request, reply, "refund"));

  app.post("/v1/ledger/:entryId/reverse", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_REQUIRED, SIGN_IN_REQUIRED);
    }
    if (!deps.verifyJwt || !deps.pool) {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
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
    const key = idempotencyKey(request);
    if (!key || !UUID.test(key)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Idempotency-Key UUID is required.", {
        field_errors: [{ field: "Idempotency-Key", message: "UUID required" }],
      });
    }
    const params = request.params as { entryId?: string };
    if (!isClientUuid(params.entryId)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "entryId", message: "A ledger entry UUID is required." }],
      });
    }
    const parsed = parseLedgerReverse(request.body ?? {});
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    const hash = requestHash({ entryId: params.entryId, ...parsed.value });
    try {
      const recorded = await withApiRole(deps.pool, async (client) => {
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
        const row = await client.query<LedgerCommandRow>(
          `select * from commercial.record_invoice_reversal(
             $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6
           )`,
          [provisioned.actor_id, key, hash, request.id, params.entryId, parsed.value.reason],
        );
        return { kind: "ok" as const, row: row.rows[0] };
      });
      if (!recorded) {
        return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      }
      if (recorded.kind === "suspended") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_SUSPENDED, "This account cannot make changes.");
      }
      if (recorded.kind === "locked") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
      }
      if (recorded.kind === "setup") {
        return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      }
      if (!recorded.row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, INVOICE_NOT_FOUND);
      }
      return success(request.id, presentLedgerCommand(recorded.row));
    } catch (error) {
      const mapped = mapInvoiceError(request, reply, error);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  function presentIssuedCredit(row: IssueRow) {
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
      pdf_state: row.pdf_state,
      request_id: row.request_id ?? null,
      delivery_state: row.delivery_state ?? null,
      snapshot: row.snapshot_json,
      net_cents: asCents(row.net_cents),
      tax_cents: asCents(row.tax_cents),
      total_cents: asCents(row.total_cents),
    };
  }

  app.post("/v1/invoices/:invoiceId/credits/preview", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    const params = request.params as { invoiceId?: string };
    if (!isClientUuid(params.invoiceId)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "invoiceId", message: "An invoice UUID is required." }],
      });
    }
    const parsed = parseCreditPreview(request.body ?? {});
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    try {
      const frozen = await withApiRole(deps.pool, async (client) => {
        await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [
          owner.workspace_id,
          owner.actor_id,
        ]);
        const invoice = await client.query<IssueRow>(
          `select d.id, d.workspace_id, d.job_id, null::uuid as draft_id, d.kind, d.number, d.revision_no, d.lifecycle,
                  d.issued_at, d.issue_date, d.due_date, d.currency, d.net_cents, d.tax_cents, d.total_cents,
                  d.snapshot_json, d.schema_version, d.snapshot_sha256, 'preparing'::text as pdf_state
           from commercial.documents d
           where d.id = $1 and d.kind = 'invoice'`,
          [params.invoiceId],
        );
        const row = invoice.rows[0];
        if (!row || row.lifecycle !== "issued") {
          return { kind: "missing" as const };
        }
        const dueDate = row.due_date
          ? asDate(row.due_date)
          : row.snapshot_json.kind === "invoice"
            ? row.snapshot_json.due_date
            : asDate(row.issue_date);
        const ledger = await loadInvoiceLedgerState(
          client,
          owner.workspace_id,
          row.id,
          asCents(row.total_cents),
          dueDate,
        );
        let calculated;
        try {
          calculated = calculateCredit(
            ledger.credit_sources.map((source) => ({
              invoice_line_id: source.invoice_line_id,
              residual_net_cents: source.residual_net_cents,
              residual_tax_cents: source.residual_tax_cents,
              credited_net_cents: source.credited_net_cents,
            })),
            parsed.value.allocations,
          );
        } catch (error) {
          return { kind: "domain" as const, error };
        }
        const snapshot = row.snapshot_json;
        const issueDate = zonedCalendarDate(new Date(), snapshot.business.timezone);
        const creditSnapshot = buildCreditSnapshot({
          business: snapshot.business,
          customer: snapshot.customer,
          job: snapshot.job,
          reason: parsed.value.reason,
          issue_date: issueDate,
          invoice_id: row.id,
          invoice_number: row.number,
          lines: calculated.allocations.map((allocation, index) => {
            const source = ledger.credit_sources.find((item) => item.invoice_line_id === allocation.source_line_id);
            return {
              position: index + 1,
              invoice_line_id: allocation.source_line_id,
              description: source?.description ?? "Credit",
              net_credit_cents: allocation.net_reduction_cents,
              tax_credit_cents: allocation.tax_reduction_cents,
              total_cents: allocation.total_reduction_cents,
            };
          }),
          net_cents: calculated.net_cents,
          tax_cents: calculated.tax_cents,
          total_cents: calculated.total_cents,
        });
        const bytes = canonicalizeToBytes(creditSnapshot);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
        const stored = await client.query<{
          id: string;
          version: number;
          preview_hash: string;
          preview_expires_at: Date | string;
          snapshot_json: CreditSnapshotV1;
        }>(
          `select id, version, preview_hash, preview_expires_at, snapshot_json
           from commercial.freeze_credit_preview(
             $1::uuid, $2::uuid, $3, $4::bytea, $5::jsonb, $6::timestamptz
           )`,
          [owner.actor_id, params.invoiceId, hash, Buffer.from(bytes), JSON.stringify(creditSnapshot), expiresAt.toISOString()],
        );
        return { kind: "ok" as const, row: stored.rows[0], snapshot: creditSnapshot, hash };
      });
      if (frozen.kind === "missing") {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, INVOICE_NOT_FOUND);
      }
      if (frozen.kind === "domain") {
        if (isDomainError(frozen.error) && frozen.error.code === "CREDIT_EXCEEDS_SOURCE") {
          return sendFail(request, reply, API_ERROR_CODES.CREDIT_EXCEEDS_SOURCE, frozen.error.message, {
            field_errors: frozen.error.field ? [{ field: frozen.error.field, message: frozen.error.message }] : [],
          });
        }
        if (isDomainError(frozen.error)) {
          return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, frozen.error.message, {
            field_errors: frozen.error.field ? [{ field: frozen.error.field, message: frozen.error.message }] : [],
          });
        }
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "This credit cannot be issued.");
      }
      if (!frozen.row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, INVOICE_NOT_FOUND);
      }
      return success(request.id, {
        draft_id: frozen.row.id,
        invoice_id: params.invoiceId,
        job_id: frozen.snapshot.job.id,
        version: frozen.row.version,
        preview_hash: frozen.hash,
        preview_expires_at: asIso(frozen.row.preview_expires_at),
        schema_version: frozen.snapshot.schema_version,
        number_label: "Draft",
        snapshot: frozen.snapshot,
      });
    } catch (error) {
      const mapped = mapInvoiceError(request, reply, error);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.post("/v1/invoices/:invoiceId/credits", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_REQUIRED, SIGN_IN_REQUIRED);
    }
    if (!deps.verifyJwt || !deps.pool) {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
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
    const key = idempotencyKey(request);
    if (!key || !UUID.test(key)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Idempotency-Key UUID is required.", {
        field_errors: [{ field: "Idempotency-Key", message: "UUID required" }],
      });
    }
    const params = request.params as { invoiceId?: string };
    if (!isClientUuid(params.invoiceId)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "invoiceId", message: "An invoice UUID is required." }],
      });
    }
    const parsed = parseCreditIssue(request.body ?? {});
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    const secrets = resolveApprovalSecrets(deps.env ?? {});
    if (!secrets) {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
    const hash = requestHash({ invoiceId: params.invoiceId, preview_hash: parsed.value.preview_hash });
    const approvalToken = generateApprovalToken();
    try {
      let tokenHash: string;
      let tokenKeyVersion: number;
      let ciphertext: Buffer;
      let nonce: Buffer;
      let algorithm: string;
      let deliveryKeyVersion: number;
      let encryptedEmail: Buffer;
      const issued = await withApiRole(deps.pool, async (client) => {
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
        const preview = await client.query<{ recipient: string | null }>(
          `select recipient
           from (
             select 1 as rank, d.preview_snapshot_json#>>'{customer,email}' as recipient
             from commercial.document_drafts d
             where d.parent_document_id = $1 and d.kind = 'credit' and d.draft_state = 'editing'
             union all
             select 2, doc.snapshot_json#>>'{customer,email}'
             from commercial.documents doc
             where doc.id = $1 and doc.kind = 'invoice'
           ) s
           where nullif(btrim(recipient), '') is not null
           order by rank
           limit 1`,
          [params.invoiceId],
        );
        const recipient = preview.rows[0]?.recipient;
        if (!recipient) {
          return { kind: "preview" as const };
        }
        const parsedRecipient = parseOwnerEmail(recipient);
        if (!parsedRecipient.ok) {
          return { kind: "preview" as const };
        }
        encodeFragmentToken(approvalToken);
        const hashed = hashApprovalToken(approvalToken, secrets.hash);
        tokenHash = hashed.hash;
        tokenKeyVersion = hashed.keyVersion;
        const encrypted = encryptDeliveryToken(approvalToken, secrets.delivery);
        ciphertext = encrypted.ciphertext;
        nonce = encrypted.nonce;
        algorithm = encrypted.algorithm;
        deliveryKeyVersion = encrypted.keyVersion;
        const packedEmail = encryptRecipientEmail(parsedRecipient.display, secrets.delivery);
        encryptedEmail = Buffer.concat([packedEmail.nonce, packedEmail.ciphertext]);
        const accessUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
        const row = await client.query<IssueRow>(
          `select id, workspace_id, job_id, draft_id, kind, number, revision_no, lifecycle, issued_at, issue_date, due_date,
                  currency, net_cents, tax_cents, total_cents, snapshot_json, schema_version, snapshot_sha256, pdf_state,
                  request_id, delivery_state, replayed
           from commercial.issue_credit(
             $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6,
             $7, $8::integer, $9::bytea, $10::bytea, $11::bytea, $12, $13::integer, $14::timestamptz
           )`,
          [
            provisioned.actor_id,
            key,
            hash,
            request.id,
            params.invoiceId,
            parsed.value.preview_hash,
            tokenHash,
            tokenKeyVersion,
            encryptedEmail,
            ciphertext,
            nonce,
            algorithm,
            deliveryKeyVersion,
            accessUntil.toISOString(),
          ],
        );
        return { kind: "ok" as const, row: row.rows[0] };
      });
      if (!issued) {
        return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      }
      if (issued.kind === "suspended") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_SUSPENDED, "This account cannot make changes.");
      }
      if (issued.kind === "locked") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
      }
      if (issued.kind === "setup") {
        return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      }
      if (issued.kind === "preview") {
        return sendFail(
          request,
          reply,
          API_ERROR_CODES.PREVIEW_CHANGED,
          "This preview is out of date. Review the credit again before issuing.",
        );
      }
      if (!issued.row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, INVOICE_NOT_FOUND);
      }
      return reply.status(202).send(success(request.id, presentIssuedCredit(issued.row)));
    } catch (error) {
      const mapped = mapInvoiceError(request, reply, error);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    } finally {
      approvalToken.fill(0);
    }
  });

  app.post("/v1/invoices/:invoiceId/void", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_REQUIRED, SIGN_IN_REQUIRED);
    }
    if (!deps.verifyJwt || !deps.pool) {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
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
    const key = idempotencyKey(request);
    if (!key || !UUID.test(key)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Idempotency-Key UUID is required.", {
        field_errors: [{ field: "Idempotency-Key", message: "UUID required" }],
      });
    }
    const params = request.params as { invoiceId?: string };
    if (!isClientUuid(params.invoiceId)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "invoiceId", message: "An invoice UUID is required." }],
      });
    }
    const parsed = parseInvoiceVoid(request.body ?? {});
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    const secrets = resolveApprovalSecrets(deps.env ?? {});
    if (!secrets) {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
    const hash = requestHash({ invoiceId: params.invoiceId, reason: parsed.value.reason });
    const notice = encryptUtf8(JSON.stringify({ kind: "voided" }), secrets.delivery);
    try {
      const voided = await withApiRole(deps.pool, async (client) => {
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
        const packedEmail = encryptRecipientEmail(parsedEmail.display, secrets.delivery);
        const row = await client.query<IssueRow>(
          `select id, workspace_id, job_id, draft_id, kind, number, revision_no, lifecycle, issued_at, issue_date, due_date,
                  currency, net_cents, tax_cents, total_cents, snapshot_json, schema_version, snapshot_sha256, pdf_state,
                  request_id, delivery_state, void_reason, replayed
           from commercial.void_invoice(
             $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6,
             $7::bytea, $8, $9::integer, $10::bytea, $11::bytea
           )`,
          [
            provisioned.actor_id,
            key,
            hash,
            request.id,
            params.invoiceId,
            parsed.value.reason,
            Buffer.concat([packedEmail.nonce, packedEmail.ciphertext]),
            notice.algorithm,
            notice.keyVersion,
            notice.nonce,
            notice.ciphertext,
          ],
        );
        return { kind: "ok" as const, row: row.rows[0] };
      });
      if (!voided) {
        return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      }
      if (voided.kind === "suspended") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_SUSPENDED, "This account cannot make changes.");
      }
      if (voided.kind === "locked") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
      }
      if (voided.kind === "setup") {
        return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      }
      if (!voided.row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, INVOICE_NOT_FOUND);
      }
      return success(request.id, presentIssuedInvoice(voided.row));
    } catch (error) {
      const mapped = mapInvoiceError(request, reply, error);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.post("/v1/invoices/:invoiceId/replacement-preview", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    const params = request.params as { invoiceId?: string };
    if (!isClientUuid(params.invoiceId)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "invoiceId", message: "An invoice UUID is required." }],
      });
    }
    const parsed = parseInvoiceReplacementPreview(request.body ?? {});
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    try {
      const frozen = await withApiRole(deps.pool, async (client) => {
        await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [
          owner.workspace_id,
          owner.actor_id,
        ]);
        const invoice = await client.query<IssueRow>(
          `select d.id, d.workspace_id, d.job_id, null::uuid as draft_id, d.kind, d.number, d.revision_no, d.lifecycle,
                  d.issued_at, d.issue_date, d.due_date, d.currency, d.net_cents, d.tax_cents, d.total_cents,
                  d.snapshot_json, d.schema_version, d.snapshot_sha256, d.void_reason, 'preparing'::text as pdf_state
           from commercial.documents d
           where d.id = $1 and d.kind = 'invoice'`,
          [params.invoiceId],
        );
        const row = invoice.rows[0];
        if (!row || row.snapshot_json.kind !== "invoice") {
          return { kind: "missing" as const };
        }
        if (row.lifecycle !== "voided") {
          return { kind: "ineligible" as const };
        }
        const source = row.snapshot_json;
        const issueDate = zonedCalendarDate(new Date(), source.business.timezone);
        const snapshot = overlayReplacementSnapshot(source, parsed.value, issueDate);
        if (
          snapshot.net_cents !== source.net_cents ||
          snapshot.tax_cents !== source.tax_cents ||
          snapshot.total_cents !== source.total_cents
        ) {
          return { kind: "invalid" as const };
        }
        const bytes = canonicalizeToBytes(snapshot);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
        const stored = await client.query<{
          id: string;
          version: number;
          preview_hash: string;
          preview_expires_at: Date | string;
          snapshot_json: InvoiceSnapshotV1;
        }>(
          `select id, version, preview_hash, preview_expires_at, snapshot_json
           from commercial.freeze_replacement_preview(
             $1::uuid, $2::uuid, $3, $4::bytea, $5::jsonb, $6::timestamptz
           )`,
          [owner.actor_id, params.invoiceId, hash, Buffer.from(bytes), JSON.stringify(snapshot), expiresAt.toISOString()],
        );
        return { kind: "ok" as const, row: stored.rows[0], snapshot, hash };
      });
      if (frozen.kind === "missing") {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, INVOICE_NOT_FOUND);
      }
      if (frozen.kind === "ineligible") {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Only a voided invoice can be replaced.");
      }
      if (frozen.kind === "invalid") {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Replacement amounts must match the voided invoice.");
      }
      if (!frozen.row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, INVOICE_NOT_FOUND);
      }
      return success(request.id, {
        draft_id: frozen.row.id,
        invoice_id: params.invoiceId,
        job_id: frozen.snapshot.job.id,
        version: frozen.row.version,
        preview_hash: frozen.hash,
        preview_expires_at: asIso(frozen.row.preview_expires_at),
        schema_version: frozen.snapshot.schema_version,
        number_label: "Draft",
        snapshot: frozen.snapshot,
        prior_document_id: params.invoiceId,
      });
    } catch (error) {
      const mapped = mapInvoiceError(request, reply, error);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.post("/v1/invoices/:invoiceId/issue-replacement", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_REQUIRED, SIGN_IN_REQUIRED);
    }
    if (!deps.verifyJwt || !deps.pool) {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
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
    const key = idempotencyKey(request);
    if (!key || !UUID.test(key)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Idempotency-Key UUID is required.", {
        field_errors: [{ field: "Idempotency-Key", message: "UUID required" }],
      });
    }
    const params = request.params as { invoiceId?: string };
    if (!isClientUuid(params.invoiceId)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "invoiceId", message: "An invoice UUID is required." }],
      });
    }
    const parsed = parseInvoiceIssue(request.body ?? {});
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    const secrets = resolveApprovalSecrets(deps.env ?? {});
    if (!secrets) {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
    const hash = requestHash({ invoiceId: params.invoiceId, preview_hash: parsed.value.preview_hash });
    const approvalToken = generateApprovalToken();
    try {
      let tokenHash: string;
      let tokenKeyVersion: number;
      let ciphertext: Buffer;
      let nonce: Buffer;
      let algorithm: string;
      let deliveryKeyVersion: number;
      let encryptedEmail: Buffer;
      const issued = await withApiRole(deps.pool, async (client) => {
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
        const preview = await client.query<{ recipient: string | null }>(
          `select recipient
           from (
             select 1 as rank, d.preview_snapshot_json#>>'{customer,email}' as recipient
             from commercial.document_drafts d
             where d.parent_document_id = $1 and d.kind = 'invoice' and d.draft_state = 'editing'
             union all
             select 2, doc.snapshot_json#>>'{customer,email}'
             from commercial.documents doc
             where doc.id = $1 and doc.kind = 'invoice'
           ) s
           where nullif(btrim(recipient), '') is not null
           order by rank
           limit 1`,
          [params.invoiceId],
        );
        const recipient = preview.rows[0]?.recipient;
        if (!recipient) {
          return { kind: "preview" as const };
        }
        const parsedRecipient = parseOwnerEmail(recipient);
        if (!parsedRecipient.ok) {
          return { kind: "preview" as const };
        }
        encodeFragmentToken(approvalToken);
        const hashed = hashApprovalToken(approvalToken, secrets.hash);
        tokenHash = hashed.hash;
        tokenKeyVersion = hashed.keyVersion;
        const encrypted = encryptDeliveryToken(approvalToken, secrets.delivery);
        ciphertext = encrypted.ciphertext;
        nonce = encrypted.nonce;
        algorithm = encrypted.algorithm;
        deliveryKeyVersion = encrypted.keyVersion;
        const packedEmail = encryptRecipientEmail(parsedRecipient.display, secrets.delivery);
        encryptedEmail = Buffer.concat([packedEmail.nonce, packedEmail.ciphertext]);
        const accessUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
        const row = await client.query<IssueRow>(
          `select id, workspace_id, job_id, draft_id, kind, number, revision_no, lifecycle, issued_at, issue_date, due_date,
                  currency, net_cents, tax_cents, total_cents, snapshot_json, schema_version, snapshot_sha256, pdf_state,
                  request_id, delivery_state, replayed
           from commercial.issue_replacement(
             $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6,
             $7, $8::integer, $9::bytea, $10::bytea, $11::bytea, $12, $13::integer, $14::timestamptz
           )`,
          [
            provisioned.actor_id,
            key,
            hash,
            request.id,
            params.invoiceId,
            parsed.value.preview_hash,
            tokenHash,
            tokenKeyVersion,
            encryptedEmail,
            ciphertext,
            nonce,
            algorithm,
            deliveryKeyVersion,
            accessUntil.toISOString(),
          ],
        );
        return { kind: "ok" as const, row: row.rows[0] };
      });
      if (!issued) {
        return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      }
      if (issued.kind === "suspended") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_SUSPENDED, "This account cannot make changes.");
      }
      if (issued.kind === "locked") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
      }
      if (issued.kind === "setup") {
        return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      }
      if (issued.kind === "preview") {
        return sendFail(
          request,
          reply,
          API_ERROR_CODES.PREVIEW_CHANGED,
          "This preview is out of date. Review the invoice again before issuing.",
        );
      }
      if (!issued.row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, INVOICE_NOT_FOUND);
      }
      return reply.status(202).send(success(request.id, presentIssuedInvoice(issued.row)));
    } catch (error) {
      const mapped = mapInvoiceError(request, reply, error);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    } finally {
      approvalToken.fill(0);
    }
  });
}
