import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import {
  renderCreditOriginalHtml,
  renderInvoiceOriginalHtml,
  renderQuoteOriginalHtml,
  type CreditPdfDocument,
  type InvoicePdfDocument,
  type QuotePdfDocument,
} from "@job-to-invoice/domain";

const require = createRequire(import.meta.url);

function fontFace(familyWeight: string, file: string): string {
  const bytes = readFileSync(require.resolve(`@fontsource/inter/files/${file}`));
  return `@font-face { font-family: Inter; font-style: normal; font-weight: ${familyWeight}; src: url(data:font/woff2;base64,${bytes.toString("base64")}) format("woff2"); }`;
}

export function embedInterFonts(html: string): string {
  const css = [
    fontFace("400", "inter-latin-400-normal.woff2"),
    fontFace("500", "inter-latin-500-normal.woff2"),
    fontFace("700", "inter-latin-700-normal.woff2"),
  ].join("\n");
  return html.replace("</style>", `${css}\n  </style>`);
}

export async function renderQuoteOriginalPdf(
  document: QuotePdfDocument | InvoicePdfDocument | CreditPdfDocument,
): Promise<Buffer> {
  const html = embedInterFonts(
    document.snapshot.kind === "invoice"
      ? renderInvoiceOriginalHtml(document as InvoicePdfDocument)
      : document.snapshot.kind === "credit"
        ? renderCreditOriginalHtml(document as CreditPdfDocument)
        : renderQuoteOriginalHtml(document as QuotePdfDocument),
  );
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({});
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url === "about:blank") {
        return route.continue();
      }
      return route.abort();
    });
    await page.setContent(html, { waitUntil: "commit" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
