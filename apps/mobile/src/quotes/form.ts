import { calculateDraftDocument, isDomainError } from "@job-to-invoice/domain";
import {
  dollarsStringToCents,
  parseDraftPayload,
  parseQuotePublish,
  parseTaxPercentToBp,
  taxBpToPercentLabel,
  type DraftPayloadInput,
  type LineUnit,
} from "@job-to-invoice/schemas";

export type QuoteLineForm = {
  client_line_id: string;
  description: string;
  unit: LineUnit;
  custom_unit_label: string;
  quantity: string;
  unit_price: string;
  discount: string;
  tax_percent: string;
};

export type QuoteFormValues = {
  notes: string;
  terms: string;
  expiry_days: string;
  lines: QuoteLineForm[];
};

export type QuoteDraftRecord = {
  id: string;
  job_id: string;
  kind: string;
  draft_state: string;
  schema_version: number;
  version: number;
  notes: string;
  terms: string;
  expiry_days: number;
  default_tax_bp: number;
  currency: string;
  lines: Array<{
    client_line_id: string;
    description: string;
    unit: LineUnit;
    custom_unit_label: string | null;
    quantity: string;
    unit_price_cents: number;
    discount_cents: number;
    tax_bp: number;
    gross_cents: number;
    net_cents: number;
    tax_cents: number;
    total_cents: number;
  }>;
  net_cents: number;
  tax_cents: number;
  total_cents: number;
};

export function centsToDollarsInput(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new Error("USD amounts must be integer cents; JavaScript floats are forbidden");
  }
  const dollars = Math.trunc(cents / 100);
  const frac = cents % 100;
  if (frac === 0) {
    return String(dollars);
  }
  return `${dollars}.${frac.toString().padStart(2, "0")}`;
}

function displayQuantity(raw: string): string {
  if (!raw.includes(".")) {
    return raw;
  }
  return raw.replace(/0+$/, "").replace(/\.$/, "");
}

export function emptyQuoteLine(id: string, taxBp = 0): QuoteLineForm {
  return {
    client_line_id: id,
    description: "",
    unit: "item",
    custom_unit_label: "",
    quantity: "1",
    unit_price: "0",
    discount: "0",
    tax_percent: taxBpToPercentLabel(taxBp),
  };
}

export function formFromDraft(draft: QuoteDraftRecord): QuoteFormValues {
  return {
    notes: draft.notes,
    terms: draft.terms,
    expiry_days: String(draft.expiry_days),
    lines: draft.lines.map((line) => ({
      client_line_id: line.client_line_id,
      description: line.description,
      unit: line.unit,
      custom_unit_label: line.custom_unit_label ?? "",
      quantity: displayQuantity(line.quantity),
      unit_price: centsToDollarsInput(line.unit_price_cents),
      discount: centsToDollarsInput(line.discount_cents),
      tax_percent: taxBpToPercentLabel(line.tax_bp),
    })),
  };
}

function quantityForPayload(raw: string): string {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }
  return trimmed;
}

export function payloadFromForm(values: QuoteFormValues): ReturnType<typeof parseDraftPayload> {
  const expiry = Number(values.expiry_days.trim());
  const lines = values.lines.map((line) => {
    const price = dollarsStringToCents(line.unit_price);
    const discount = dollarsStringToCents(line.discount);
    const tax = parseTaxPercentToBp(line.tax_percent);
    const body: Record<string, unknown> = {
      client_line_id: line.client_line_id,
      description: line.description,
      unit: line.unit,
      quantity: quantityForPayload(line.quantity),
      unit_price_cents: price.ok ? price.value : line.unit_price,
      discount_cents: discount.ok ? discount.value : line.discount,
      tax_bp: tax.ok ? tax.value : line.tax_percent,
    };
    if (line.unit === "custom") {
      body.custom_unit_label = line.custom_unit_label;
    }
    return body;
  });
  return parseDraftPayload({
    notes: values.notes,
    terms: values.terms,
    expiry_days: Number.isInteger(expiry) ? expiry : values.expiry_days,
    lines,
  });
}

export function liveTotals(values: QuoteFormValues) {
  const parsed = payloadFromForm(values);
  if (!parsed.ok) {
    return { ok: false as const, field_errors: parsed.field_errors };
  }
  try {
    return { ok: true as const, value: parsed.value, totals: calculateDraftDocument(parsed.value.lines) };
  } catch (error) {
    if (isDomainError(error)) {
      return {
        ok: false as const,
        field_errors: error.field ? [{ field: error.field, message: error.message }] : [{ field: "lines", message: error.message }],
      };
    }
    return { ok: false as const, field_errors: [{ field: "lines", message: "Could not calculate totals." }] };
  }
}

export function moveLine(lines: QuoteLineForm[], index: number, direction: -1 | 1): QuoteLineForm[] {
  const next = index + direction;
  if (next < 0 || next >= lines.length) {
    return lines;
  }
  const copy = [...lines];
  const current = copy[index];
  const swapped = copy[next];
  if (!current || !swapped) {
    return lines;
  }
  copy[index] = swapped;
  copy[next] = current;
  return copy;
}

export function firstQuoteFieldError(errors: Record<string, string>): string | undefined {
  return Object.keys(errors)[0];
}

export function quotePublishBody(previewHash: string, recipientEmail: string, replacePendingRequestId?: string) {
  return parseQuotePublish({
    preview_hash: previewHash,
    recipient_email: recipientEmail,
    ...(replacePendingRequestId ? { replace_pending_request_id: replacePendingRequestId } : {}),
  });
}

export type DraftPayload = DraftPayloadInput;
