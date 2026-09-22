import { formatUsdCents } from "@job-to-invoice/schemas";
import { escapeHtml, formatCalendarDate } from "./quote-html.ts";
import type { ChangeSnapshotV1 } from "./snapshot.ts";

export const CHANGE_PDF_TEMPLATE_VERSION = "change-original-v1";

export type ChangePdfDocument = {
  number: string;
  revision_no: number;
  snapshot: ChangeSnapshotV1;
  net_cents: number;
  tax_cents: number;
  total_cents: number;
};

export function renderChangeOriginalHtml(document: ChangePdfDocument): string {
  const snapshot = document.snapshot;
  if (snapshot.kind !== "change") {
    throw new Error("PDF source must be a published change snapshot");
  }
  if (snapshot.additions.length + snapshot.reductions.length < 1) {
    throw new Error("PDF source must include at least one change line");
  }
  if (
    document.net_cents !== snapshot.net_cents ||
    document.tax_cents !== snapshot.tax_cents ||
    document.total_cents !== snapshot.total_cents
  ) {
    throw new Error("PDF totals must match the issued snapshot");
  }
  const additionRows = snapshot.additions
    .map(
      (line) => `<tr>
        <td>${line.position}</td>
        <td>${escapeHtml(line.description)}</td>
        <td>${escapeHtml(line.quantity)}</td>
        <td class="num">${escapeHtml(formatUsdCents(line.total_cents))}</td>
      </tr>`,
    )
    .join("");
  const reductionRows = snapshot.reductions
    .map(
      (line) => `<tr>
        <td>${line.position}</td>
        <td>${escapeHtml(line.description)}</td>
        <td class="num">${escapeHtml(formatUsdCents(line.net_credit_cents))}</td>
        <td class="num">${escapeHtml(formatUsdCents(line.total_reduction_cents))}</td>
      </tr>`,
    )
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
    .totals { width: 56%; margin-left: auto; }
    .notes { white-space: pre-wrap; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(snapshot.business.business_name)}</h1>
    <div class="muted">${escapeHtml(snapshot.business.legal_name)}</div>
  </header>
  <h2>Change order ${escapeHtml(document.number)} · R${document.revision_no}</h2>
  <div>Issue date: ${escapeHtml(formatCalendarDate(snapshot.issue_date))}</div>
  <div>Currency: ${escapeHtml(snapshot.currency)}</div>
  <h2>Customer</h2>
  <div>${escapeHtml(snapshot.customer.name)}</div>
  ${snapshot.reason ? `<h2>Reason</h2><div class="notes">${escapeHtml(snapshot.reason)}</div>` : ""}
  ${
    snapshot.additions.length
      ? `<h2>Additions</h2><table><thead><tr><th>#</th><th>Description</th><th>Qty</th><th class="num">Total</th></tr></thead><tbody>${additionRows}</tbody></table>`
      : ""
  }
  ${
    snapshot.reductions.length
      ? `<h2>Reductions</h2><table><thead><tr><th>#</th><th>Description</th><th class="num">Net credit</th><th class="num">Including tax</th></tr></thead><tbody>${reductionRows}</tbody></table>`
      : ""
  }
  <table class="totals">
    <tr><th>Previously agreed total</th><td class="num">${escapeHtml(formatUsdCents(snapshot.previous_total_cents))}</td></tr>
    <tr><th>Change including tax</th><td class="num">${escapeHtml(formatUsdCents(snapshot.change_including_tax_cents))}</td></tr>
    <tr><th>New agreed total</th><td class="num">${escapeHtml(formatUsdCents(snapshot.new_agreed_total_cents))}</td></tr>
  </table>
  <h2>Terms</h2>
  <div class="notes">${escapeHtml(snapshot.terms || "—")}</div>
</body>
</html>`;
}
