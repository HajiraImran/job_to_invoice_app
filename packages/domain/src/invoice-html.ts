import { formatUsdCents } from "@job-to-invoice/schemas";
import {
  discountCentsTotal,
  escapeHtml,
  formatCalendarDate,
  formatTaxBp,
  type QuotePdfLine,
} from "./quote-html.ts";
import type { InvoiceSnapshotV1 } from "./snapshot.ts";

export const INVOICE_PDF_TEMPLATE_VERSION = "invoice-original-v1";

export type InvoicePdfDocument = {
  number: string;
  revision_no: number;
  snapshot: InvoiceSnapshotV1;
  lines: QuotePdfLine[];
  net_cents: number;
  tax_cents: number;
  total_cents: number;
};

function addressHtml(address: InvoiceSnapshotV1["business"]["address"]): string {
  if (!address) {
    return "";
  }
  const lines = [address.line1, address.line2, `${address.city}, ${address.state} ${address.postal_code}`].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  return lines.map((line) => escapeHtml(line)).join("<br/>");
}

export function renderInvoiceOriginalHtml(document: InvoicePdfDocument): string {
  const snapshot = document.snapshot;
  if (snapshot.kind !== "invoice") {
    throw new Error("PDF source must be a published invoice snapshot");
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
      const unit = line.custom_unit_label ? line.custom_unit_label : (line.unit ?? "");
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
  <h2>Invoice ${escapeHtml(document.number)} · R${document.revision_no}</h2>
  <div>Issue date: ${escapeHtml(formatCalendarDate(snapshot.issue_date))}</div>
  <div>Due date: ${escapeHtml(formatCalendarDate(snapshot.due_date))}</div>
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
  <h2>Payment instructions</h2>
  <div class="notes">${escapeHtml(snapshot.payment_instructions || "—")}</div>
</body>
</html>`;
}
