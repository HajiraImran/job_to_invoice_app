import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const role = ["service", "role"].join("_");
const forbidden = [
  new RegExp(role, "i"),
  new RegExp(["SUPABASE", "SERVICE", "ROLE"].join("_")),
  /BEGIN RSA PRIVATE KEY/,
  new RegExp(["sk", "live", ""].join("_")),
];
const skipDirs = new Set(["node_modules", ".git", ".next", "dist", ".turbo", "docs", "coverage"]);
const skipFiles = new Set(["secret-scan.mjs"]);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (skipDirs.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, files);
    } else if (/\.(ts|tsx|js|mjs|json|yml|yaml)$/.test(entry) && !skipFiles.has(entry)) {
      files.push(full);
    }
  }
  return files;
}

const files = walk(workspaceRoot);
const hits = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(text)) {
      hits.push(`${relative(workspaceRoot, file)} matches ${pattern}`);
    }
  }
}

if (hits.length > 0) {
  console.error(hits.join("\n"));
  process.exit(1);
}

console.log(`Secret scan passed (${files.length} files).`);
