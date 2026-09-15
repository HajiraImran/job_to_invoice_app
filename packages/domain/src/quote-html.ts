import { formatUsdCents } from "@job-to-invoice/schemas";
import type { QuoteSnapshotAddress, QuoteSnapshotV1 } from "./snapshot.ts";

export const QUOTE_PDF_TEMPLATE_VERSION = "quote-original-v1";

export type QuotePdfLine = {
  position: number;
  description: string;
  quantity: string | null;
  unit: string | null;
  custom_unit_label?: string | null;
  unit_price_cents: number | null;
  discount_cents: number;
  net_cents: number;
  tax_bp: number;
  tax_cents: number;
  total_cents: number;
};

export type QuotePdfDocument = {
  number: string;
  revision_no: number;
  snapshot: QuoteSnapshotV1;
  lines: QuotePdfLine[];
  net_cents: number;
  tax_cents: number;
  total_cents: number;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export function originalPdfObjectKey(input: {
  workspaceId: string;
  documentId: string;
  revision: number;
  artifactId: string;
}): string {
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    throw new Error("revision starts at 1");
  }
  return `workspaces/${input.workspaceId}/documents/${input.documentId}/revisions/${input.revision}/original/${input.artifactId}.pdf`;
}

export function formatTaxBp(taxBp: number): string {
  if (!Number.isInteger(taxBp) || taxBp < 0) {
    throw new Error("tax basis points must be a nonnegative integer");
  }
  const digits = taxBp.toString();
  const padded = digits.length >= 3 ? digits : digits.padStart(3, "0");
  return `${padded.slice(0, -2)}.${padded.slice(-2)}%`;
}

export function formatCalendarDate(isoDate: string): string {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(isoDate);
  if (!match) {
    throw new Error("calendar dates must be YYYY-MM-DD");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error("calendar dates must be YYYY-MM-DD");
  }
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

export function discountCentsTotal(lines: QuotePdfLine[]): number {
  let sum = 0;
  for (const line of lines) {
    if (!Number.isInteger(line.discount_cents)) {
      throw new Error("USD amounts must be integer cents; JavaScript floats are forbidden");
    }
    sum += line.discount_cents;
  }
  return sum;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function addressHtml(address: QuoteSnapshotAddress | null): string {
  if (!address) {
    return "";
  }
  const lines = [address.line1, address.line2, `${address.city}, ${address.state} ${address.postal_code}`].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  return lines.map((line) => escapeHtml(line)).join("<br/>");
}

export function renderQuoteOriginalHtml(document: QuotePdfDocument): string {
  const snapshot = document.snapshot;
  if (snapshot.kind !== "quote") {
    throw new Error("PDF source must be a published quote snapshot");
  }
  if (document.lines.length < 1) {
    throw new Error("PDF source must include at least one line");
  }
  if (
    document.net_cents !== snapshot.net_cents ||
    document.tax_cents !== snapshot.tax_cents ||
    document.total_cents !== snapshot.total_cents
  ) {
    throw new Error("PDF totals must match the issued snapshot");
  }
  const discount = discountCentsTotal(document.lines);
  const site = snapshot.job.no_site
    ? "No site address"
    : addressHtml(snapshot.job.site_address) || "No site address";
  const lineRows = document.lines
    .map((line) => {
      const unit = line.custom_unit_label
        ? line.custom_unit_label
        : line.unit ?? "";
      return `<tr>
        <td>${line.position}</td>
        <td>${escapeHtml(line.description)}</td>
        <td>${escapeHtml(line.quantity ?? "")}</td>
        <td>${escapeHtml(unit)}</td>
        <td class="num">${line.unit_price_cents == null ? "" : escapeHtml(formatUsdCents(line.unit_price_cents))}</td>
        <td class="num">${escapeHtml(formatUsdCents(line.discount_cents))}</td>
        <td>${escapeHtml(formatTaxBp(line.tax_bp))}</td>
        <td class="num">${escapeHtml(formatUsdCents(line.total_cents))}</td>
      </tr>`;
    })
    .join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${escapeHtml(document.number)} R${document.revision_no}</title>
  <style>
    :root { color-scheme: only light; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: Inter, "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-size: 11pt;
      color: #102a43;
      background: #ffffff;
    }
    @page {
      size: A4 portrait;
      margin: 18mm;
      @bottom-center {
        content: "Page " counter(page) " of " counter(pages);
        font-family: Inter, "Helvetica Neue", Helvetica, Arial, sans-serif;
        font-size: 9pt;
        color: #486581;
      }
    }
    h1 { font-size: 18pt; font-weight: 700; margin: 0 0 4px; }
    h2 { font-size: 12pt; font-weight: 600; margin: 16px 0 6px; }
    .muted { color: #486581; font-size: 10pt; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    thead { display: table-header-group; }
    th, td { border-bottom: 1px solid #d9e2ec; padding: 6px 4px; text-align: left; vertical-align: top; }
    th { font-weight: 600; font-size: 10pt; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    .totals { width: 46%; margin-left: auto; }
    .notes { white-space: pre-wrap; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(snapshot.business.business_name)}</h1>
    <div class="muted">${escapeHtml(snapshot.business.legal_name)}</div>
    <div>${escapeHtml(snapshot.business.contact_name)} · ${escapeHtml(snapshot.business.contact_email)}${
      snapshot.business.contact_phone ? ` · ${escapeHtml(snapshot.business.contact_phone)}` : ""
    }</div>
    <div>${addressHtml(snapshot.business.address)}</div>
  </header>
  <h2>Quote ${escapeHtml(document.number)} · R${document.revision_no}</h2>
  <div>Issue date: ${escapeHtml(formatCalendarDate(snapshot.issue_date))}</div>
  <div>Expiry: ${escapeHtml(formatCalendarDate(snapshot.expiry_local_date))} (${escapeHtml(snapshot.expiry_timezone)})</div>
  <div>Currency: ${escapeHtml(snapshot.currency)}</div>
  <h2>Customer</h2>
  <div>${escapeHtml(snapshot.customer.name)}</div>
  ${snapshot.customer.email ? `<div>${escapeHtml(snapshot.customer.email)}</div>` : ""}
  ${snapshot.customer.phone ? `<div>${escapeHtml(snapshot.customer.phone)}</div>` : ""}
  <div>${addressHtml(snapshot.customer.billing_address)}</div>
  <h2>Job</h2>
  <div>${escapeHtml(snapshot.job.title)}</div>
  <div>${site}</div>
  <table>
    <thead>
      <tr>
        <th>#</th><th>Description</th><th>Qty</th><th>Unit</th>
        <th class="num">Price</th><th class="num">Discount</th><th>Tax</th><th class="num">Total</th>
      </tr>
    </thead>
    <tbody>${lineRows}</tbody>
  </table>
  <table class="totals">
    <tr><th>Subtotal</th><td class="num">${escapeHtml(formatUsdCents(document.net_cents))}</td></tr>
    <tr><th>Discount</th><td class="num">${escapeHtml(formatUsdCents(discount))}</td></tr>
    <tr><th>Tax</th><td class="num">${escapeHtml(formatUsdCents(document.tax_cents))}</td></tr>
    <tr><th>Total</th><td class="num">${escapeHtml(formatUsdCents(document.total_cents))}</td></tr>
  </table>
  ${snapshot.notes ? `<h2>Notes</h2><div class="notes">${escapeHtml(snapshot.notes)}</div>` : ""}
  <h2>Terms</h2>
  <div class="notes">${escapeHtml(snapshot.terms || "—")}</div>
</body>
</html>`;
}
