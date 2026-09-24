import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(root, "openapi", "v1.json");
const spec = JSON.parse(readFileSync(specPath, "utf8"));

const errors = [];
if (spec.openapi !== "3.1.0") {
  errors.push("openapi must be 3.1.0");
}
if (!spec.paths?.["/v1/health"]?.get) {
  errors.push("GET /v1/health is required");
}
if (!spec.paths?.["/v1/me"]?.get) {
  errors.push("GET /v1/me is required");
}
if (!spec.paths?.["/v1/analytics/batch"]?.post) {
  errors.push("POST /v1/analytics/batch is required");
}
if (!spec.paths?.["/v1/workspace"]?.post) {
  errors.push("POST /v1/workspace is required");
}
if (!spec.paths?.["/v1/jobs"]?.get) {
  errors.push("GET /v1/jobs is required");
}
if (!spec.paths?.["/v1/jobs"]?.post) {
  errors.push("POST /v1/jobs is required");
}
if (!spec.paths?.["/v1/jobs/{jobId}"]?.get) {
  errors.push("GET /v1/jobs/{jobId} is required");
}
if (!spec.paths?.["/v1/jobs/{jobId}/quote"]?.post) {
  errors.push("POST /v1/jobs/{jobId}/quote is required");
}
if (!spec.paths?.["/v1/jobs/{jobId}/changes"]?.post) {
  errors.push("POST /v1/jobs/{jobId}/changes is required");
}
if (
  spec.paths?.["/v1/jobs/{jobId}/changes"]?.post &&
  !spec.paths["/v1/jobs/{jobId}/changes"].post.parameters?.some((item) => item.name === "Idempotency-Key")
) {
  errors.push("POST /v1/jobs/{jobId}/changes requires Idempotency-Key");
}
if (!spec.paths?.["/v1/jobs/{jobId}/invoice-preview"]?.post) {
  errors.push("POST /v1/jobs/{jobId}/invoice-preview is required");
}
if (!spec.paths?.["/v1/jobs/{jobId}/issue-invoice"]?.post) {
  errors.push("POST /v1/jobs/{jobId}/issue-invoice is required");
}
if (!spec.paths?.["/v1/invoices/{invoiceId}/ledger"]?.get) {
  errors.push("GET /v1/invoices/{invoiceId}/ledger is required");
}
if (!spec.paths?.["/v1/invoices/{invoiceId}/payments"]?.post) {
  errors.push("POST /v1/invoices/{invoiceId}/payments is required");
}
if (
  spec.paths?.["/v1/invoices/{invoiceId}/payments"]?.post &&
  !spec.paths["/v1/invoices/{invoiceId}/payments"].post.parameters?.some((item) => item.name === "Idempotency-Key")
) {
  errors.push("POST /v1/invoices/{invoiceId}/payments requires Idempotency-Key");
}
if (!spec.paths?.["/v1/invoices/{invoiceId}/void"]?.post) {
  errors.push("POST /v1/invoices/{invoiceId}/void is required");
}
if (
  spec.paths?.["/v1/invoices/{invoiceId}/void"]?.post &&
  !spec.paths["/v1/invoices/{invoiceId}/void"].post.parameters?.some((item) => item.name === "Idempotency-Key")
) {
  errors.push("POST /v1/invoices/{invoiceId}/void requires Idempotency-Key");
}
if (!spec.paths?.["/v1/invoices/{invoiceId}/replacement-preview"]?.post) {
  errors.push("POST /v1/invoices/{invoiceId}/replacement-preview is required");
}
if (!spec.paths?.["/v1/invoices/{invoiceId}/issue-replacement"]?.post) {
  errors.push("POST /v1/invoices/{invoiceId}/issue-replacement is required");
}
if (
  spec.paths?.["/v1/invoices/{invoiceId}/issue-replacement"]?.post &&
  !spec.paths["/v1/invoices/{invoiceId}/issue-replacement"].post.parameters?.some((item) => item.name === "Idempotency-Key")
) {
  errors.push("POST /v1/invoices/{invoiceId}/issue-replacement requires Idempotency-Key");
}
if (!spec.paths?.["/v1/invoices/{invoiceId}/refunds"]?.post) {
  errors.push("POST /v1/invoices/{invoiceId}/refunds is required");
}
if (
  spec.paths?.["/v1/invoices/{invoiceId}/refunds"]?.post &&
  !spec.paths["/v1/invoices/{invoiceId}/refunds"].post.parameters?.some((item) => item.name === "Idempotency-Key")
) {
  errors.push("POST /v1/invoices/{invoiceId}/refunds requires Idempotency-Key");
}
if (
  spec.paths?.["/v1/jobs/{jobId}/issue-invoice"]?.post &&
  !spec.paths["/v1/jobs/{jobId}/issue-invoice"].post.parameters?.some((item) => item.name === "Idempotency-Key")
) {
  errors.push("POST /v1/jobs/{jobId}/issue-invoice requires Idempotency-Key");
}
if (!spec.paths?.["/v1/drafts/{draftId}"]?.get) {
  errors.push("GET /v1/drafts/{draftId} is required");
}
if (!spec.paths?.["/v1/drafts/{draftId}"]?.patch) {
  errors.push("PATCH /v1/drafts/{draftId} is required");
}
if (spec.paths?.["/v1/drafts/{draftId}"]?.patch && !spec.paths["/v1/drafts/{draftId}"].patch.parameters?.some((item) => item.name === "If-Match")) {
  errors.push("PATCH /v1/drafts/{draftId} requires If-Match");
}
if (!spec.paths?.["/v1/drafts/{draftId}/preview"]?.post) {
  errors.push("POST /v1/drafts/{draftId}/preview is required");
}
if (!spec.paths?.["/v1/drafts/{draftId}/publish"]?.post) {
  errors.push("POST /v1/drafts/{draftId}/publish is required");
}
if (spec.paths?.["/v1/drafts/{draftId}/publish"]?.post && !spec.paths["/v1/drafts/{draftId}/publish"].post.parameters?.some((item) => item.name === "Idempotency-Key")) {
  errors.push("POST /v1/drafts/{draftId}/publish requires Idempotency-Key");
}
if (!spec.paths?.["/v1/documents/{documentId}"]?.get) {
  errors.push("GET /v1/documents/{documentId} is required");
}
if (!spec.paths?.["/v1/documents/{documentId}/download"]?.get) {
  errors.push("GET /v1/documents/{documentId}/download is required");
}
if (spec.paths?.["/v1/documents/{documentId}/download"]?.get && !/5-minute|five-minute/i.test(spec.paths["/v1/documents/{documentId}/download"].get.responses?.["200"]?.description ?? "")) {
  errors.push("GET /v1/documents/{documentId}/download must describe the 5-minute URL");
}
if (spec.paths?.["/v1/drafts"] && !spec.paths["/v1/drafts/{draftId}"]) {
  errors.push("draft collection routes must not be declared until they are implemented");
}

if (!spec.paths?.["/v1/portal/exchange"]?.post) {
  errors.push("POST /v1/portal/exchange is required");
}
if (!spec.paths?.["/v1/portal/code/send"]?.post) {
  errors.push("POST /v1/portal/code/send is required");
}
if (!spec.paths?.["/v1/portal/code/verify"]?.post) {
  errors.push("POST /v1/portal/code/verify is required");
}
if (!spec.paths?.["/v1/portal/document"]?.get) {
  errors.push("GET /v1/portal/document is required");
}
if (!spec.paths?.["/v1/portal/decision"]?.post) {
  errors.push("POST /v1/portal/decision is required");
}
if (spec.paths?.["/v1/portal/decision"]?.post && !spec.paths["/v1/portal/decision"].post.parameters?.some((item) => item.name === "Idempotency-Key")) {
  errors.push("POST /v1/portal/decision requires Idempotency-Key");
}
if (!spec.paths?.["/v1/portal/receipt"]?.get) {
  errors.push("GET /v1/portal/receipt is required");
}
if (!spec.paths?.["/v1/portal/download"]?.get) {
  errors.push("GET /v1/portal/download is required");
}
if (spec.paths?.["/v1/portal/download"]?.get && !/5-minute|five-minute/i.test(spec.paths["/v1/portal/download"].get.responses?.["200"]?.description ?? "")) {
  errors.push("GET /v1/portal/download must describe the 5-minute URL");
}
if (!spec.paths?.["/v1/portal/report"]?.post) {
  errors.push("POST /v1/portal/report is required");
}

if (!spec.paths?.["/v1/account/action-grants"]?.post) {
  errors.push("POST /v1/account/action-grants is required");
}
if (
  spec.paths?.["/v1/account/action-grants"]?.post &&
  !/auth_time|fresh/i.test(
    `${spec.paths["/v1/account/action-grants"].post.description ?? ""} ${spec.paths["/v1/account/action-grants"].post.responses?.["403"]?.description ?? ""}`,
  )
) {
  errors.push("POST /v1/account/action-grants must document fresh auth_time / ACTION_GRANT_REQUIRED");
}
if (!spec.paths?.["/v1/requests/{requestId}/resend"]?.post) {
  errors.push("POST /v1/requests/{requestId}/resend is required");
}
if (
  spec.paths?.["/v1/requests/{requestId}/resend"]?.post &&
  !spec.paths["/v1/requests/{requestId}/resend"].post.parameters?.some((item) => item.name === "Idempotency-Key")
) {
  errors.push("POST /v1/requests/{requestId}/resend requires Idempotency-Key");
}
if (
  spec.paths?.["/v1/requests/{requestId}/resend"]?.post &&
  !spec.paths["/v1/requests/{requestId}/resend"].post.responses?.["429"]
) {
  errors.push("POST /v1/requests/{requestId}/resend must document 429 Retry-After for NTF04");
}
if (!spec.paths?.["/v1/requests/{requestId}/withdraw"]?.post) {
  errors.push("POST /v1/requests/{requestId}/withdraw is required");
}
if (
  spec.paths?.["/v1/requests/{requestId}/withdraw"]?.post &&
  !spec.paths["/v1/requests/{requestId}/withdraw"].post.parameters?.some((item) => item.name === "Idempotency-Key")
) {
  errors.push("POST /v1/requests/{requestId}/withdraw requires Idempotency-Key");
}
if (!spec.paths?.["/v1/requests/{requestId}/replace-link"]?.post) {
  errors.push("POST /v1/requests/{requestId}/replace-link is required");
}
if (
  spec.paths?.["/v1/requests/{requestId}/replace-link"]?.post &&
  !spec.paths["/v1/requests/{requestId}/replace-link"].post.parameters?.some((item) => item.name === "Idempotency-Key")
) {
  errors.push("POST /v1/requests/{requestId}/replace-link requires Idempotency-Key");
}
if (
  spec.paths?.["/v1/requests/{requestId}/replace-link"]?.post &&
  !spec.paths["/v1/requests/{requestId}/replace-link"].post.parameters?.some((item) => item.name === "X-Action-Grant")
) {
  errors.push("POST /v1/requests/{requestId}/replace-link requires X-Action-Grant");
}
if (
  spec.paths?.["/v1/requests/{requestId}/resend"]?.post?.parameters?.some((item) => item.name === "If-Match") ||
  spec.paths?.["/v1/requests/{requestId}/withdraw"]?.post?.parameters?.some((item) => item.name === "If-Match") ||
  spec.paths?.["/v1/requests/{requestId}/replace-link"]?.post?.parameters?.some((item) => item.name === "If-Match")
) {
  errors.push("S12 request mutations must not require If-Match (not implemented)");
}

if (!spec.paths?.["/v1/customers"]?.get || !spec.paths?.["/v1/customers"]?.post) {
  errors.push("GET and POST /v1/customers are required");
}
if (!spec.paths?.["/v1/customers/{customerId}"]?.get || !spec.paths?.["/v1/customers/{customerId}"]?.patch || !spec.paths?.["/v1/customers/{customerId}"]?.delete) {
  errors.push("GET, PATCH, and DELETE /v1/customers/{customerId} are required");
}
if (!spec.paths?.["/v1/customers/{customerId}/archive"]?.post) {
  errors.push("POST /v1/customers/{customerId}/archive is required");
}
if (spec.paths?.["/v1/customers/{customerId}/archive"]?.post?.parameters?.some((item) => item.name === "If-Match")) {
  errors.push("Customer archive must not require If-Match");
}
if (!spec.paths?.["/v1/customers/{customerId}"]?.patch?.parameters?.some((item) => item.name === "If-Match")) {
  errors.push("PATCH /v1/customers/{customerId} requires If-Match");
}
if (!spec.components?.schemas?.CustomerCreate || !spec.components?.schemas?.PostalAddress) {
  errors.push("CustomerCreate and PostalAddress schemas are required");
}
if (spec.components?.schemas?.PostalAddress && !spec.components.schemas.PostalAddress.properties?.postal_code) {
  errors.push("PostalAddress must use postal_code");
}
if (spec.components?.schemas?.PostalAddress?.properties?.zip) {
  errors.push("PostalAddress must not use zip");
}
const jobGet = spec.paths?.["/v1/jobs"]?.get;
if (!jobGet?.parameters?.some((item) => item.name === "customer_id")) {
  errors.push("GET /v1/jobs must accept customer_id");
}
if (!spec.components?.schemas?.JobCreate?.properties?.customer_id) {
  errors.push("JobCreate must accept customer_id");
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log("OpenAPI 3.1 owner jobs, quote-publish, invoice-issue, invoice-ledger, portal, and S12 request-controls contract is valid.");
