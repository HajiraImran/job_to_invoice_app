import { calculateDocument, type DocumentTotals } from "./document.ts";
import type { LineInput } from "./line.ts";

export const QUOTE_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const FREE_JOB_LIMIT = 3;
export const PREVIEW_TTL_MS = 10 * 60 * 1000;

export type QuoteSnapshotAddress = {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
};

export type QuoteSnapshotLine = {
  position: number;
  client_line_id: string;
  description: string;
  unit: string;
  custom_unit_label: string | null;
  quantity: string;
  unit_price_cents: number;
  discount_cents: number;
  tax_bp: number;
  gross_cents: number;
  net_cents: number;
  tax_cents: number;
  total_cents: number;
};

export type QuoteSnapshotV1 = {
  schema_version: typeof QUOTE_SNAPSHOT_SCHEMA_VERSION;
  kind: "quote";
  currency: "USD";
  business: {
    business_name: string;
    legal_name: string;
    contact_name: string;
    contact_email: string;
    contact_phone: string | null;
    address: QuoteSnapshotAddress | null;
    timezone: string;
    default_tax_bp: number;
  };
  customer: {
    name: string;
    email: string | null;
    phone: string | null;
    billing_address: QuoteSnapshotAddress | null;
  };
  job: {
    id: string;
    title: string;
    site_address: QuoteSnapshotAddress | null;
    no_site: boolean;
  };
  notes: string;
  terms: string;
  expiry_days: number;
  expiry_local_date: string;
  expiry_timezone: string;
  expires_at: string;
  issue_date: string;
  lines: QuoteSnapshotLine[];
  net_cents: number;
  tax_cents: number;
  total_cents: number;
  tax_by_rate: Array<{ tax_bp: number; net_cents: number; tax_cents: number }>;
};

export const INVOICE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type InvoiceSnapshotLine = {
  position: number;
  source_line_id: string;
  description: string;
  unit: string;
  custom_unit_label: string | null;
  quantity: string;
  unit_price_cents: number;
  discount_cents: number;
  tax_bp: number;
  gross_cents: number;
  net_cents: number;
  tax_cents: number;
  total_cents: number;
};

export type InvoiceSnapshotV1 = {
  schema_version: typeof INVOICE_SNAPSHOT_SCHEMA_VERSION;
  kind: "invoice";
  currency: "USD";
  business: QuoteSnapshotV1["business"];
  customer: QuoteSnapshotV1["customer"];
  job: QuoteSnapshotV1["job"];
  notes: string;
  payment_instructions: string;
  issue_date: string;
  due_date: string;
  source_quote_id: string;
  source_quote_number: string;
  lines: InvoiceSnapshotLine[];
  net_cents: number;
  tax_cents: number;
  total_cents: number;
  tax_by_rate: Array<{ tax_bp: number; net_cents: number; tax_cents: number }>;
};

export type ResidualSourceLine = InvoiceSnapshotLine;

export const CREDIT_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type CreditSnapshotLine = {
  position: number;
  invoice_line_id: string;
  description: string;
  net_credit_cents: number;
  tax_credit_cents: number;
  total_cents: number;
};

export type CreditSnapshotV1 = {
  schema_version: typeof CREDIT_SNAPSHOT_SCHEMA_VERSION;
  kind: "credit";
  currency: "USD";
  business: QuoteSnapshotV1["business"];
  customer: QuoteSnapshotV1["customer"];
  job: QuoteSnapshotV1["job"];
  reason: string;
  issue_date: string;
  invoice_id: string;
  invoice_number: string;
  lines: CreditSnapshotLine[];
  net_cents: number;
  tax_cents: number;
  total_cents: number;
};

export function buildCreditSnapshot(input: {
  business: QuoteSnapshotV1["business"];
  customer: QuoteSnapshotV1["customer"];
  job: QuoteSnapshotV1["job"];
  reason: string;
  issue_date: string;
  invoice_id: string;
  invoice_number: string;
  lines: CreditSnapshotLine[];
  net_cents: number;
  tax_cents: number;
  total_cents: number;
}): CreditSnapshotV1 {
  if (input.lines.length < 1) {
    throw new Error("A credit must allocate at least one invoice line");
  }
  return {
    schema_version: CREDIT_SNAPSHOT_SCHEMA_VERSION,
    kind: "credit",
    currency: "USD",
    business: input.business,
    customer: input.customer,
    job: input.job,
    reason: input.reason,
    issue_date: input.issue_date,
    invoice_id: input.invoice_id,
    invoice_number: input.invoice_number,
    lines: input.lines,
    net_cents: input.net_cents,
    tax_cents: input.tax_cents,
    total_cents: input.total_cents,
  };
}

export function buildInvoiceSnapshot(input: {
  business: QuoteSnapshotV1["business"];
  customer: QuoteSnapshotV1["customer"];
  job: QuoteSnapshotV1["job"];
  notes: string;
  payment_instructions: string;
  issue_date: string;
  due_date: string;
  source_quote_id: string;
  source_quote_number: string;
  lines: ResidualSourceLine[];
  net_cents: number;
  tax_cents: number;
  total_cents: number;
  tax_by_rate: InvoiceSnapshotV1["tax_by_rate"];
}): InvoiceSnapshotV1 {
  if (input.lines.length < 1) {
    throw new Error("An invoice must retain its source lines");
  }
  return {
    schema_version: INVOICE_SNAPSHOT_SCHEMA_VERSION,
    kind: "invoice",
    currency: "USD",
    business: input.business,
    customer: input.customer,
    job: input.job,
    notes: input.notes,
    payment_instructions: input.payment_instructions,
    issue_date: input.issue_date,
    due_date: input.due_date,
    source_quote_id: input.source_quote_id,
    source_quote_number: input.source_quote_number,
    lines: input.lines,
    net_cents: input.net_cents,
    tax_cents: input.tax_cents,
    total_cents: input.total_cents,
    tax_by_rate: input.tax_by_rate,
  };
}

export type QuoteDraftLineSnapshotInput = LineInput & {
  client_line_id: string;
  description: string;
  unit: string;
  custom_unit_label: string | null;
};

export function formatDocumentNumber(kind: "quote" | "change" | "invoice" | "credit", value: number): string {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Document numbers start at 1");
  }
  const prefix = kind === "quote" ? "Q" : kind === "change" ? "CO" : kind === "invoice" ? "INV" : "CN";
  return `${prefix}-${String(value).padStart(6, "0")}`;
}

export function lineCountBucket(count: number): "1" | "2_to_5" | "6_to_20" | "21_to_100" {
  if (count <= 1) {
    return "1";
  }
  if (count <= 5) {
    return "2_to_5";
  }
  if (count <= 20) {
    return "6_to_20";
  }
  return "21_to_100";
}

export function buildQuoteSnapshot(input: {
  business: QuoteSnapshotV1["business"];
  customer: QuoteSnapshotV1["customer"];
  job: QuoteSnapshotV1["job"];
  notes: string;
  terms: string;
  expiry_days: number;
  expiry_local_date: string;
  expiry_timezone: string;
  expires_at: string;
  issue_date: string;
  lines: QuoteDraftLineSnapshotInput[];
}): { snapshot: QuoteSnapshotV1; totals: DocumentTotals } {
  const totals = calculateDocument(input.lines, { require_positive_net: true });
  const calculatedById = new Map(totals.lines.map((line) => [line.client_line_id, line]));
  const lines: QuoteSnapshotLine[] = input.lines.map((line, index) => {
    const money = calculatedById.get(line.client_line_id);
    if (!money) {
      throw new Error("Calculated line missing for snapshot");
    }
    return {
      position: index + 1,
      client_line_id: line.client_line_id,
      description: line.description,
      unit: line.unit,
      custom_unit_label: line.custom_unit_label,
      quantity: money.quantity,
      unit_price_cents: money.unit_price_cents,
      discount_cents: money.discount_cents,
      tax_bp: money.tax_bp,
      gross_cents: money.gross_cents,
      net_cents: money.net_cents,
      tax_cents: money.tax_cents,
      total_cents: money.total_cents,
    };
  });
  return {
    totals,
    snapshot: {
      schema_version: QUOTE_SNAPSHOT_SCHEMA_VERSION,
      kind: "quote",
      currency: "USD",
      business: input.business,
      customer: input.customer,
      job: input.job,
      notes: input.notes,
      terms: input.terms,
      expiry_days: input.expiry_days,
      expiry_local_date: input.expiry_local_date,
      expiry_timezone: input.expiry_timezone,
      expires_at: input.expires_at,
      issue_date: input.issue_date,
      lines,
      net_cents: totals.net_cents,
      tax_cents: totals.tax_cents,
      total_cents: totals.total_cents,
      tax_by_rate: totals.tax_by_rate,
    },
  };
}
