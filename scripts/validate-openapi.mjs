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
if (!spec.paths?.["/v1/drafts/{draftId}"]?.get) {
  errors.push("GET /v1/drafts/{draftId} is required");
}
if (!spec.paths?.["/v1/drafts/{draftId}"]?.patch) {
  errors.push("PATCH /v1/drafts/{draftId} is required");
}
if (spec.paths?.["/v1/drafts/{draftId}"]?.patch && !spec.paths["/v1/drafts/{draftId}"].patch.parameters?.some((item) => item.name === "If-Match")) {
  errors.push("PATCH /v1/drafts/{draftId} requires If-Match");
}
if (spec.paths?.["/v1/drafts"] && !spec.paths["/v1/drafts/{draftId}"]) {
  errors.push("draft collection routes must not be declared until they are implemented");
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log("OpenAPI 3.1 owner jobs and quote-draft contract is valid.");
