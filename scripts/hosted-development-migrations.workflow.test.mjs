import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflowPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".github",
  "workflows",
  "hosted-development-migrations.yml",
);
const forbiddenRole = ["service", "role"].join("_");
const confirmationExpr = "CONFIRMATION: ${{ github.event.inputs.confirmation }}";
const checkoutRefExpr = "ref: ${{ github.sha }}";
const secretExpr = "DATABASE_URL_MIGRATIONS: ${{ secrets.DATABASE_URL_MIGRATIONS }}";
const maskCmd = 'echo "::add-mask::${DATABASE_URL_MIGRATIONS}"';

function jobBody(yaml, name) {
  const header = yaml.match(new RegExp(`^  ${name}:\\n`, "m"));
  assert.ok(header, `job ${name} is missing`);
  const startIndex = header.index + header[0].length;
  const rest = yaml.slice(startIndex);
  const next = rest.match(/^  [a-zA-Z][\w-]*:/m);
  return next ? rest.slice(0, next.index) : rest;
}

function namedSteps(job) {
  return [...job.matchAll(/^\s+- name: (.+)$/gm)].map((match) => match[1]);
}

test("hosted development migration workflow is dispatch-only and statically gated", () => {
  const yaml = readFileSync(workflowPath, "utf8");

  assert.match(yaml, /^on:\n  workflow_dispatch:\n    inputs:\n      confirmation:/m);
  assert.match(yaml, /^\s+required: true$/m);
  assert.doesNotMatch(yaml, /^\s+push:/m);
  assert.doesNotMatch(yaml, /^\s+pull_request:/m);
  assert.doesNotMatch(yaml, /^\s+schedule:/m);
  assert.doesNotMatch(yaml, /workflow_call:/);

  assert.match(yaml, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(yaml, /contents:\s+write/);
  assert.doesNotMatch(yaml, /id-token:/);
  assert.doesNotMatch(yaml, /packages:/);

  assert.match(
    yaml,
    /^concurrency:\n  group: hosted-development-migrations\n  cancel-in-progress: false\n/m,
  );

  const confirm = jobBody(yaml, "confirm");
  const apply = jobBody(yaml, "apply");

  assert.match(confirm, /runs-on: ubuntu-latest/);
  assert.equal(confirm.includes(confirmationExpr), true);
  assert.match(
    yaml,
    /Type APPLY_0015 to apply pending hosted development migration 0015_invoice_credits\.sql/,
  );
  assert.match(confirm, /\[ "\$CONFIRMATION" != "APPLY_0015" \]/);
  assert.doesNotMatch(yaml, /APPLY_0013/);
  assert.doesNotMatch(yaml, /APPLY_0014/);
  assert.doesNotMatch(confirm, /secrets\./);
  assert.doesNotMatch(confirm, /DATABASE_URL_MIGRATIONS/);
  assert.doesNotMatch(confirm, /environment:/);

  assert.match(apply, /needs: confirm/);
  assert.match(apply, /runs-on: ubuntu-latest/);
  assert.match(apply, /environment: development/);
  assert.match(apply, /uses: actions\/checkout@v5/);
  assert.equal(apply.includes(checkoutRefExpr), true);
  assert.match(apply, /persist-credentials: false/);
  assert.match(apply, /uses: pnpm\/action-setup@v4/);
  assert.match(apply, /version: 12\.4\.1/);
  assert.match(apply, /uses: actions\/setup-node@v4/);
  assert.match(apply, /node-version: 22\.23\.2/);
  assert.match(apply, /cache: pnpm/);
  assert.match(apply, /pnpm install --frozen-lockfile/);
  assert.match(apply, /printf '%s' 'fhgacxkpgjdcjuvanesv' > supabase\/\.temp\/project-ref/);

  const checkIndex = apply.indexOf("pnpm hosted:db-check");
  const pushIndex = apply.indexOf("pnpm hosted:db-push");
  const verifyIndex = apply.lastIndexOf("pnpm hosted:db-check");
  assert.notEqual(checkIndex, -1);
  assert.notEqual(pushIndex, -1);
  assert.ok(checkIndex < pushIndex);
  assert.ok(pushIndex < verifyIndex);
  assert.equal([...apply.matchAll(/pnpm hosted:db-push/g)].length, 1);
  assert.equal([...apply.matchAll(/pnpm hosted:db-check/g)].length, 2);
  assert.equal([...apply.matchAll(/grep -qx 'ok: true'/g)].length, 2);
  assert.match(apply, /grep -qx 'pending: 0015_invoice_credits\.sql'/);
  assert.match(apply, /grep -qx 'pending: \(none\)'/);
  assert.ok(
    apply.indexOf("pending: 0015_invoice_credits.sql") < apply.indexOf("pnpm hosted:db-push"),
  );

  assert.doesNotMatch(yaml, /^env:/m);
  assert.doesNotMatch(apply, /^    env:/m);
  assert.equal(apply.split(secretExpr).length - 1, 3);
  assert.equal(apply.split(maskCmd).length - 1, 3);

  const cleanup = apply.split("- name: Clean hosted apply metadata")[1];
  assert.ok(cleanup);
  assert.match(cleanup, /if: always\(\)/);
  assert.match(cleanup, /unset DATABASE_URL_MIGRATIONS/);
  assert.match(cleanup, /rm -f supabase\/\.temp\/project-ref/);
  assert.doesNotMatch(cleanup, /secrets\./);
  assert.doesNotMatch(cleanup, /add-mask/);

  const names = namedSteps(apply);
  assert.ok(
    names.indexOf("Check pending hosted migration 0015") <
      names.indexOf("Apply hosted migration 0015"),
  );
  assert.ok(
    names.indexOf("Apply hosted migration 0015") <
      names.indexOf("Verify no pending hosted migrations"),
  );
  assert.ok(
    names.indexOf("Verify no pending hosted migrations") <
      names.indexOf("Clean hosted apply metadata"),
  );

  assert.doesNotMatch(yaml, /--linked/);
  assert.doesNotMatch(yaml, /migrate:clean/);
  assert.doesNotMatch(yaml, /include-all/);
  assert.doesNotMatch(yaml, /include-roles/);
  assert.doesNotMatch(yaml, /include-seed/);
  assert.doesNotMatch(yaml, /history repair/);
  assert.doesNotMatch(yaml, /--debug/);
  assert.doesNotMatch(yaml, /printenv/);
  assert.doesNotMatch(yaml, /set -x/);
  assert.doesNotMatch(yaml, /retries:/);
  assert.doesNotMatch(yaml, /max-attempts/);
  assert.doesNotMatch(yaml, /uses: .*retry/i);
  assert.doesNotMatch(yaml, /supabase db push/);
  assert.doesNotMatch(yaml, new RegExp(forbiddenRole, "i"));
});
