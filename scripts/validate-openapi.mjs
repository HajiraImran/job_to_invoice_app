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
if (spec.paths?.["/v1/jobs"] || spec.paths?.["/v1/drafts"]) {
  errors.push("commercial routes must not be declared until they are implemented");
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log("OpenAPI 3.1 authentication contract is valid.");
