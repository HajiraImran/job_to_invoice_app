import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const forbiddenRole = ["service", "role"].join("_");
const GENERIC_APPLY_FAILURE = "hosted apply failed";
const GENERIC_OUTPUT_OMITTED =
  "hosted apply output omitted because credentials cannot be redacted safely";
const SESSION_POOLER_HOST = /^aws-0-[a-z]{2}(?:-[a-z]+)+-\d+\.pooler\.supabase\.com$/;
const PROJECT_REF = /^[a-z0-9]{20}$/;
const CREDENTIAL_URI = /(?:postgres|postgresql):\/\/[^\s"'`\\]+/gi;
const DEFAULT_PROJECT_REF_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "supabase",
  ".temp",
  "project-ref",
);
const JS_ENTRY_UNRESOLVED = "D-012: Supabase CLI JavaScript entry could not be resolved";
const localRequire = createRequire(import.meta.url);

export function hostedDbPushArgv(url, { dryRun = false } = {}) {
  const argv = ["db", "push", "--db-url", url];
  if (dryRun) {
    argv.push("--dry-run");
  } else {
    argv.push("--yes");
  }
  return argv;
}

function isRegularNamedJsEntry(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")) {
    return null;
  }
  let real;
  try {
    real = realpathSync(path.resolve(candidate));
  } catch {
    return null;
  }
  try {
    if (!statSync(real).isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  if (path.basename(real) !== "supabase.js") {
    return null;
  }
  return real;
}

export function splitSearchPath(pathEnv, delimiter = path.delimiter) {
  if (typeof pathEnv !== "string" || pathEnv.length === 0) {
    return [];
  }
  const entries = [];
  let current = "";
  let inQuotes = false;
  for (const char of pathEnv) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === delimiter && !inQuotes) {
      const entry = current.trim();
      if (entry && !entry.includes("\0")) {
        entries.push(entry);
      }
      current = "";
      continue;
    }
    current += char;
  }
  if (inQuotes) {
    return entries;
  }
  const last = current.trim();
  if (last && !last.includes("\0")) {
    entries.push(last);
  }
  return entries;
}

function isRegularFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveFromNpmShimPath({ pathEnv = process.env.PATH, pathDelimiter = path.delimiter } = {}) {
  for (const entry of splitSearchPath(pathEnv, pathDelimiter)) {
    const shimDir = path.resolve(entry);
    const shim = path.join(shimDir, "supabase.cmd");
    if (!isRegularFile(shim)) {
      continue;
    }
    const derived = path.join(shimDir, "node_modules", "supabase", "dist", "supabase.js");
    const jsEntry = isRegularNamedJsEntry(derived);
    if (jsEntry) {
      return jsEntry;
    }
  }
  return null;
}

export function resolveSupabaseJsEntry({
  requireResolve = (id) => localRequire.resolve(id),
  pathEnv = process.env.PATH,
  pathDelimiter = path.delimiter,
} = {}) {
  try {
    const fromPackage = isRegularNamedJsEntry(requireResolve("supabase/dist/supabase.js"));
    if (fromPackage) {
      return fromPackage;
    }
  } catch {
    // Fall back to an on-PATH npm shim layout. Do not execute the shim.
  }
  const fromPath = resolveFromNpmShimPath({ pathEnv, pathDelimiter });
  if (fromPath) {
    return fromPath;
  }
  throw new Error(JS_ENTRY_UNRESOLVED);
}

export function hostedCliLaunch(
  url,
  {
    execPath = process.execPath,
    requireResolve,
    pathEnv,
    pathDelimiter,
    dryRun = false,
  } = {},
) {
  const cliArgv = hostedDbPushArgv(url, { dryRun });
  const spawnOptions = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  };
  const jsEntry = resolveSupabaseJsEntry({ requireResolve, pathEnv, pathDelimiter });
  return {
    command: execPath,
    argv: [jsEntry, ...cliArgv],
    spawnOptions,
  };
}

const FAILURE_CATEGORIES = new Set([
  "url_encoding_failure",
  "url_parse_failure",
  "pooler_circuit_breaker",
  "authentication_failed",
  "tenant_not_found",
  "pooler_capacity",
  "connection_timeout",
  "connection_refused",
  "connection_reset",
  "dns_failure",
  "tls_failure",
  "login_role_failure",
  "migration_history_mismatch",
  "migration_sql_error",
  "cli_auth_required",
  "cli_start_failure",
  "unknown_failure",
]);
const REPORT_STAGES = new Set([
  "preflight",
  "login_role",
  "connecting",
  "listing_pending",
  "applying",
  "unknown",
]);

// Fixed vocabulary only: names are printed, matched child text never is.
// Phrases are the ones the pinned Go CLI (pgx/pgconn) and Supavisor emit.
const CLI_SIGNALS = [
  ["url_parse", /cannot parse `|failed to parse as (?:URL|DSN|keyword)|invalid userinfo|invalid URL escape|invalid port|invalid character .{0,40} in (?:host name|URL)|net\/url:/i],
  ["circuit_breaker", /circuit breaker/i],
  ["password_rejected", /password authentication failed|\b28P01\b/i],
  ["sasl_failed", /failed SASL auth|SASL authentication|\bsasl\b|SCRAM/i],
  ["tenant_or_user_not_found", /tenant or user not found/i],
  ["pooler_capacity", /max client connections|EMAXCONN|too many (?:clients|connections)|\b53300\b|unable to check out/i],
  ["hostname_resolve", /hostname resolving error|no such host|\bENOTFOUND\b|getaddrinfo|dns (?:look ?up|resolution) failed/i],
  ["connection_refused", /\bECONNREFUSED\b|connection refused|actively refused/i],
  ["tls", /\btls error\b|\btls:|x509:|\b(?:SSL|TLS)\b|certificate verify|self[- ]signed certificate|server refused TLS/i],
  ["dial_error", /dial error|dial tcp/i],
  ["timeout", /\bETIMEDOUT\b|i\/o timeout|context deadline exceeded|connection timed out|connect timed out|connection attempt failed|timeout:/i],
  ["connection_reset", /unexpected EOF|connection reset|forcibly closed|broken pipe|\bECONNRESET\b|failed to receive message|failed to write startup message/i],
  ["server_error", /server error/i],
  ["connect_failed", /failed to connect to postgres|failed to connect to `|LegacyDbConnectError/i],
  ["login_role", /permission denied to alter role|failed to connect as temp role|failed to initialise login role|LegacyDbConfigLoginRole|LegacyDbConfigConnectTempRole/i],
  ["remote_history_not_local", /remote migration versions not found/i],
  ["local_before_remote", /found local migration files to be inserted before/i],
  ["migration_repair_suggested", /migration repair/i],
  ["sqlstate", /SQLSTATE/i],
  ["cli_access_token", /access token not provided|supabase login/i],
  ["cli_project_ref", /cannot find project ref|supabase link/i],
  ["cli_project_config", /failed to read project config|cannot read config|config\.toml/i],
  ["cli_unknown_flag", /unknown (?:flag|shorthand flag|command)/i],
  ["cli_binary_missing", /no matching supabase cli binary|unsupported (?:platform|architecture)/i],
  ["cli_suggests_debug", /rerunning the command with --debug/i],
  ["cli_update_notice", /new version of supabase cli is available/i],
];

const HINTS = {
  url_encoding_failure:
    "Percent-encode the password (encodeURIComponent) before setting DATABASE_URL_MIGRATIONS; the Go CLI rejects characters Node accepts.",
  url_parse_failure:
    "The CLI could not parse DATABASE_URL_MIGRATIONS. Percent-encode reserved or non-ASCII password characters.",
  pooler_circuit_breaker:
    "Supavisor blocked this user after repeated auth failures. Wait several minutes, fix the password, then retry once.",
  authentication_failed:
    "Password rejected. Reset the database password or recopy it; in PowerShell set the variable with single quotes so $ and ` are not interpolated.",
  tenant_not_found:
    "Supavisor does not know this user/region. Check the pooler region host and that the user is postgres.<linked-ref>.",
  pooler_capacity: "Session pooler is at its client limit. Close other session-mode clients and retry.",
  connection_timeout: "The CLI timed out dialing the pooler. Retry on a stable network or use the CI workflow (D-012).",
  connection_refused: "The pooler refused the connection. Check the host and port 5432.",
  connection_reset: "The pooler closed the connection mid-handshake. Retry once; if repeated, use the CI workflow (D-012).",
  dns_failure: "The CLI could not resolve the pooler host.",
  tls_failure: "TLS negotiation with the pooler failed in the CLI.",
  login_role_failure: "The CLI login-role step failed; do not use --linked (D-012).",
  migration_history_mismatch:
    "Connected, but remote migration history differs from supabase/migrations. Do not repair history without review.",
  migration_sql_error: "Connected and a migration statement failed.",
  cli_auth_required: "The CLI wants a Supabase access token; --db-url should not need one.",
  cli_start_failure: "The Supabase CLI could not start.",
};

// Go net/url validUserinfo: anything else makes the CLI reject the URL.
const GO_USERINFO_OK = /^[A-Za-z0-9\-._:~!$&'()*+,;=%@]*$/;

export function analyzeMigrationUrlEncoding(url) {
  const raw = String(url ?? "");
  const issues = [];
  const schemeEnd = raw.indexOf("://");
  const afterScheme = schemeEnd >= 0 ? raw.slice(schemeEnd + 3) : raw;
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authority = authorityEnd >= 0 ? afterScheme.slice(0, authorityEnd) : afterScheme;
  const at = authority.lastIndexOf("@");
  const userinfo = at >= 0 ? authority.slice(0, at) : "";
  const colon = userinfo.indexOf(":");
  const password = colon >= 0 ? userinfo.slice(colon + 1) : "";
  const beyondAuthority = afterScheme.slice(authority.length);
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) {
    issues.push("whitespace_or_control");
  }
  if (/["`]/.test(raw)) {
    issues.push("quote_chars");
  }
  if (/[^\u0000-\u007f]/.test(password)) {
    issues.push("non_ascii");
  }
  if (password && !GO_USERINFO_OK.test(password)) {
    issues.push("unencoded_unsafe_chars");
  }
  if (/%(?![0-9A-Fa-f]{2})/.test(password)) {
    issues.push("invalid_percent_escape");
  }
  if (password.includes("@")) {
    issues.push("raw_at_sign");
  }
  if (/@/.test(beyondAuthority.split(/[?#]/)[0] ?? "")) {
    issues.push("raw_url_delimiter");
  }
  let nodeDecodes = true;
  try {
    decodeURIComponent(password);
  } catch {
    nodeDecodes = false;
  }
  const blocking = issues.filter((issue) => issue !== "raw_at_sign");
  return {
    passwordPresent: password.length > 0,
    passwordPercentEncoded: /%[0-9A-Fa-f]{2}/.test(password),
    nodeDecodes,
    cliCompatible: password.length > 0 && blocking.length === 0 && nodeDecodes,
    issues,
  };
}

export function detectCliSignals(text) {
  const source = String(text ?? "");
  return CLI_SIGNALS.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
}
const SAFE_ERROR_CODES = new Set([
  "28P01",
  "08001",
  "08004",
  "08006",
  "57P01",
  "57P03",
  "53300",
  "XX000",
  "42501",
  "42P01",
  "EINVAL",
  "ENOENT",
  "EACCES",
  "EPERM",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ECONNRESET",
]);
const MIGRATION_BASENAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const SAFE_CODE_PATTERN = new RegExp(`\\b(${[...SAFE_ERROR_CODES].join("|")})\\b`);
const CLI_TAG_PATTERN = /LegacyDb[A-Za-z]+/g;
const MAX_STATEMENT = 100_000;

export function extractPendingMigrationBasenames(text) {
  const found = new Set();
  const source = String(text ?? "");
  const pattern = /(?<![A-Za-z0-9_.])(\d{4}_[a-z0-9_]+\.sql)(?![A-Za-z0-9_.])/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    if (MIGRATION_BASENAME.test(name)) {
      found.add(name);
    }
  }
  return [...found].sort();
}

function isReportableCode(value) {
  return typeof value === "string" && (SAFE_ERROR_CODES.has(value) || SQLSTATE.test(value));
}

function extractSqlstate(text) {
  const source = String(text ?? "");
  const prefixed = source.match(/SQLSTATE\s+([0-9A-Z]{5})\b/i) ?? source.match(/ERROR:\s+([0-9A-Z]{5})\b/i);
  if (prefixed && SQLSTATE.test(prefixed[1])) {
    return prefixed[1];
  }
  return null;
}

function extractSafeErrorCode(text, spawnError) {
  const spawnCode = spawnError && typeof spawnError.code === "string" ? spawnError.code : "";
  if (isReportableCode(spawnCode)) {
    return spawnCode;
  }
  const sqlstate = extractSqlstate(text);
  if (sqlstate) {
    return sqlstate;
  }
  const source = String(text ?? "");
  const match = source.match(SAFE_CODE_PATTERN);
  if (match && isReportableCode(match[1])) {
    return match[1];
  }
  return null;
}

function extractStage(text) {
  const source = String(text ?? "");
  let stage = "unknown";
  if (/initialis(?:e|ing) login role/i.test(source)) {
    stage = "login_role";
  }
  if (/connecting to remote database/i.test(source)) {
    stage = "connecting";
  }
  if (
    /would apply the following|would push these migrations|remote database is up to date|schema migrations are up to date|remote migration versions not found|found local migration files to be inserted before/i.test(
      source,
    )
  ) {
    stage = "listing_pending";
  }
  if (/applying migration/i.test(source)) {
    stage = "applying";
  }
  return stage;
}

function extractCliTag(text) {
  const source = String(text ?? "");
  let tag = null;
  for (const match of source.matchAll(CLI_TAG_PATTERN)) {
    if (match[0].length <= 80) {
      tag = match[0];
    }
  }
  return tag;
}

function extractStatementNumber(text) {
  const source = String(text ?? "");
  let statement = null;
  for (const match of source.matchAll(/\bstatement\s+(\d+)\b/gi)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_STATEMENT) {
      statement = n;
    }
  }
  return statement;
}

function extractFailedMigrationBasename(text) {
  const source = String(text ?? "");
  const applying = source.match(/applying migration\s+[:\-]?\s*(\d{4}_[a-z0-9_]+\.sql)/i);
  if (applying && MIGRATION_BASENAME.test(applying[1])) {
    return applying[1];
  }
  const pending = extractPendingMigrationBasenames(source);
  return pending.length === 1 ? pending[0] : null;
}

function classifyFailureCategory(text, spawnError, signals = detectCliSignals(text)) {
  if (spawnError) {
    return "cli_start_failure";
  }
  const source = String(text ?? "");
  const has = (name) => signals.includes(name);
  if (has("url_parse")) {
    return "url_parse_failure";
  }
  if (has("circuit_breaker")) {
    return "pooler_circuit_breaker";
  }
  if (has("password_rejected") || has("sasl_failed") || /invalid (authorization|password)/i.test(source)) {
    return "authentication_failed";
  }
  if (has("tenant_or_user_not_found")) {
    return "tenant_not_found";
  }
  if (has("pooler_capacity")) {
    return "pooler_capacity";
  }
  if (has("hostname_resolve")) {
    return "dns_failure";
  }
  if (has("connection_refused")) {
    return "connection_refused";
  }
  if (has("tls")) {
    return "tls_failure";
  }
  if (has("timeout") || /LegacyDbConnectError/i.test(source)) {
    return "connection_timeout";
  }
  if (has("connection_reset")) {
    return "connection_reset";
  }
  if (has("login_role")) {
    return "login_role_failure";
  }
  if (has("remote_history_not_local") || has("local_before_remote")) {
    return "migration_history_mismatch";
  }
  if (
    /LegacyDbPushApplyError|SQLSTATE|syntax error|at character \d+|permission denied/i.test(source)
  ) {
    return "migration_sql_error";
  }
  if (has("cli_access_token")) {
    return "cli_auth_required";
  }
  return "unknown_failure";
}

export function classifyHostedCliOutput({
  status = 1,
  stdout = "",
  stderr = "",
  spawnError = null,
} = {}) {
  const text = `${stdout ?? ""}\n${stderr ?? ""}`;
  const exitCode = spawnError ? 1 : status === null || status === undefined ? 1 : status;
  const ok = !spawnError && exitCode === 0;
  const signals = detectCliSignals(text);
  const connectionInit = /initialis(?:e|ing) login role|connecting to remote database/i.test(text);
  const connectionSucceeded =
    /remote database is up to date|schema migrations are up to date|would apply the following|would push these migrations|finished supabase db push|applying migration|remote migration versions not found|found local migration files to be inserted before/i.test(
      text,
    ) && !/connection timed out|password authentication failed|econnrefused|enotfound|failed to connect to postgres/i.test(text);
  const pending = extractPendingMigrationBasenames(text);
  const category = ok ? null : classifyFailureCategory(text, spawnError, signals);
  const code = extractSafeErrorCode(text, spawnError);
  return {
    signals,
    outputPresent: String(stdout ?? "").trim() !== "" || String(stderr ?? "").trim() !== "",
    ok,
    exitCode,
    connectionInit,
    connectionSucceeded,
    pending,
    stage: extractStage(text),
    migration: extractFailedMigrationBasename(text),
    statement: extractStatementNumber(text),
    cliTag: extractCliTag(text),
    category: category && FAILURE_CATEGORIES.has(category) ? category : ok ? null : "unknown_failure",
    code,
  };
}

export function formatSanitizedReport(result) {
  const exitCode = Number.isInteger(result.exitCode) ? result.exitCode : 1;
  const pending = Array.isArray(result.pending)
    ? result.pending.filter((name) => MIGRATION_BASENAME.test(name))
    : [];
  const stage = REPORT_STAGES.has(result.stage) ? result.stage : "unknown";
  const lines = [
    `ok: ${result.ok ? "true" : "false"}`,
    `exit: ${exitCode}`,
    `connection_init: ${result.connectionInit ? "true" : "false"}`,
    `connection: ${result.connectionSucceeded ? "true" : "false"}`,
    `pending: ${pending.length > 0 ? pending.join(",") : "(none)"}`,
    `stage: ${stage}`,
  ];
  if (!result.ok) {
    const category = FAILURE_CATEGORIES.has(result.category) ? result.category : "unknown_failure";
    lines.push(`category: ${category}`);
    if (MIGRATION_BASENAME.test(result.migration)) {
      lines.push(`migration: ${result.migration}`);
    }
    if (Number.isInteger(result.statement) && result.statement >= 1 && result.statement <= MAX_STATEMENT) {
      lines.push(`statement: ${result.statement}`);
    }
    if (isReportableCode(result.code)) {
      lines.push(`code: ${result.code}`);
    }
    if (typeof result.cliTag === "string" && /^LegacyDb[A-Za-z]{1,80}$/.test(result.cliTag)) {
      lines.push(`cli_tag: ${result.cliTag}`);
    }
  }
  const known = new Set(CLI_SIGNALS.map(([name]) => name));
  if (Array.isArray(result.signals)) {
    const signals = result.signals.filter((name) => known.has(name));
    lines.push(`cli_signals: ${signals.length > 0 ? signals.join(",") : "(none)"}`);
  }
  if (typeof result.outputPresent === "boolean") {
    lines.push(`cli_output: ${result.outputPresent ? "present" : "empty"}`);
  }
  const encoding = result.encoding;
  if (encoding && typeof encoding === "object") {
    const allowed = new Set([
      "whitespace_or_control",
      "quote_chars",
      "non_ascii",
      "unencoded_unsafe_chars",
      "invalid_percent_escape",
      "raw_at_sign",
      "raw_url_delimiter",
    ]);
    const issues = Array.isArray(encoding.issues) ? encoding.issues.filter((issue) => allowed.has(issue)) : [];
    lines.push(`password_percent_encoded: ${encoding.passwordPercentEncoded ? "true" : "false"}`);
    lines.push(`password_cli_compatible: ${encoding.cliCompatible ? "true" : "false"}`);
    lines.push(`password_issues: ${issues.length > 0 ? issues.join(",") : "(none)"}`);
  }
  if (!result.ok) {
    const category = FAILURE_CATEGORIES.has(result.category) ? result.category : "unknown_failure";
    const hint =
      HINTS[category] ??
      (Array.isArray(result.signals) && result.signals.length === 0 && result.outputPresent
        ? "CLI output matched no known phrase. Retry once; if repeated, use the CI workflow (D-012)."
        : undefined);
    if (hint) {
      lines.push(`hint: ${hint}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function isExecutedAsMain(metaUrl, argv1 = process.argv[1], platform = process.platform) {
  if (typeof argv1 !== "string" || argv1.length === 0) {
    return false;
  }
  let selfPath;
  try {
    selfPath = fileURLToPath(metaUrl);
  } catch {
    return false;
  }
  let invokedPath;
  try {
    invokedPath = argv1.startsWith("file:") ? fileURLToPath(argv1) : path.resolve(argv1);
  } catch {
    return false;
  }
  const left = path.normalize(selfPath);
  const right = path.normalize(invokedPath);
  if (platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

export function readLinkedProjectRef(filePath = DEFAULT_PROJECT_REF_PATH) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    throw new Error("D-012: linked project-ref file is missing or unreadable");
  }
  const ref = String(raw).replace(/^\uFEFF/, "").trim();
  if (!ref) {
    throw new Error("D-012: linked project-ref is empty");
  }
  if (!PROJECT_REF.test(ref)) {
    throw new Error("D-012: linked project-ref is malformed");
  }
  return ref;
}

function looksLikeCredential(text) {
  const value = String(text ?? "");
  if (CREDENTIAL_URI.test(value)) {
    CREDENTIAL_URI.lastIndex = 0;
    return true;
  }
  CREDENTIAL_URI.lastIndex = 0;
  return value.includes("://") && value.includes("@");
}

function secretFragments(url) {
  try {
    const parsed = new URL(url.replace(/^postgresql:/i, "postgres:"));
    const encoded = parsed.password;
    if (!encoded) {
      return null;
    }
    let decoded = encoded;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      return null;
    }
    if (encoded.length < 8 || decoded.length < 8) {
      return null;
    }
    const fragments = new Set([url, encoded, decoded]);
    if (parsed.username) {
      fragments.add(`${parsed.username}:${encoded}`);
      fragments.add(`${parsed.username}:${decoded}`);
    }
    return [...fragments].sort((a, b) => b.length - a.length);
  } catch {
    return null;
  }
}

export function redactCapturedOutput(text, url) {
  if (text == null || text === "") {
    return "";
  }
  const secrets = secretFragments(url);
  if (!secrets) {
    return GENERIC_OUTPUT_OMITTED;
  }
  let out = String(text);
  for (const secret of secrets) {
    out = out.split(secret).join("[redacted]");
  }
  out = out.replace(CREDENTIAL_URI, "[DATABASE_URL_MIGRATIONS]");
  CREDENTIAL_URI.lastIndex = 0;
  if (secrets.some((secret) => out.includes(secret))) {
    return GENERIC_OUTPUT_OMITTED;
  }
  if (looksLikeCredential(out)) {
    return GENERIC_OUTPUT_OMITTED;
  }
  return out;
}

export function assertSafeHostedMigrationUrl(urlString, expectedProjectRef) {
  if (!urlString || typeof urlString !== "string") {
    throw new Error("DATABASE_URL_MIGRATIONS is required for hosted apply (D-012)");
  }
  if (!expectedProjectRef || !PROJECT_REF.test(expectedProjectRef)) {
    throw new Error("D-012: linked project-ref is malformed");
  }
  const trimmed = urlString.trim();
  if (trimmed.toLowerCase().includes(forbiddenRole)) {
    throw new Error("DATABASE_URL_MIGRATIONS must not use a privileged Supabase role");
  }
  if (!/^(postgres|postgresql):\/\//i.test(trimmed)) {
    throw new Error("DATABASE_URL_MIGRATIONS must use postgres:// or postgresql://");
  }
  let parsed;
  try {
    parsed = new URL(trimmed.replace(/^postgresql:/i, "postgres:"));
  } catch {
    throw new Error("DATABASE_URL_MIGRATIONS is not a valid URL");
  }
  if (parsed.search !== "" || parsed.searchParams.size > 0 || parsed.hash !== "") {
    throw new Error(
      "D-012: session pooler URL must not include query parameters or fragments",
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (/^db\.[a-z0-9]+\.supabase\.co$/.test(host)) {
    throw new Error(
      "D-012: db.<ref>.supabase.co is IPv6-only. Use the IPv4 session pooler on port 5432",
    );
  }
  if (!SESSION_POOLER_HOST.test(host)) {
    throw new Error("D-012: hosted apply must use aws-0-<region>.pooler.supabase.com:5432");
  }
  if (parsed.port === "") {
    throw new Error("D-012: session pooler port 5432 must be explicit");
  }
  if (parsed.port === "6543") {
    throw new Error(
      "D-012: transaction pooler port 6543 cannot apply SET ROLE migrations. Use session mode port 5432",
    );
  }
  if (parsed.port !== "5432") {
    throw new Error("D-012: session pooler must use port 5432");
  }
  const expectedUser = `postgres.${expectedProjectRef}`;
  if (parsed.username !== expectedUser) {
    throw new Error("D-012: session pooler user must be postgres.<linked-project-ref>");
  }
  if (!parsed.password) {
    throw new Error("DATABASE_URL_MIGRATIONS must include a password");
  }
  return parsed;
}

function safeErrorMessage(error) {
  if (!(error instanceof Error) || looksLikeCredential(error.message)) {
    return GENERIC_APPLY_FAILURE;
  }
  return error.message || GENERIC_APPLY_FAILURE;
}

export function runHostedDbPush(
  url,
  {
    spawn = spawnSync,
    platform = process.platform,
    execPath = process.execPath,
    requireResolve,
    pathEnv,
    pathDelimiter,
    dryRun = false,
    stdout = process.stdout,
    stderr = process.stderr,
    encoding = analyzeMigrationUrlEncoding(url),
  } = {},
) {
  if (!encoding.cliCompatible && !dryRun) {
    stdout.write(
      formatSanitizedReport({
        ok: false,
        exitCode: 1,
        connectionInit: false,
        connectionSucceeded: false,
        pending: [],
        stage: "preflight",
        category: "url_encoding_failure",
        encoding,
      }),
    );
    return 1;
  }
  const launch = hostedCliLaunch(url, {
    platform,
    execPath,
    requireResolve,
    pathEnv,
    pathDelimiter,
    dryRun,
  });
  const result = spawn(launch.command, launch.argv, launch.spawnOptions);
  const classified = classifyHostedCliOutput({
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    spawnError: result.error ?? null,
  });
  if (!classified.ok && !encoding.cliCompatible && classified.category === "unknown_failure") {
    classified.category = "url_encoding_failure";
  }
  stdout.write(formatSanitizedReport({ ...classified, encoding }));
  return classified.exitCode;
}

export async function applyHostedMigrations({
  env = process.env,
  projectRefPath = DEFAULT_PROJECT_REF_PATH,
  spawn = spawnSync,
  platform = process.platform,
  execPath = process.execPath,
  requireResolve,
  pathEnv,
  pathDelimiter,
  dryRun = false,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const expectedRef = readLinkedProjectRef(projectRefPath);
  const rawUrl = env.DATABASE_URL_MIGRATIONS;
  const url = typeof rawUrl === "string" ? rawUrl.trim() : rawUrl;
  assertSafeHostedMigrationUrl(url, expectedRef);
  return runHostedDbPush(url, {
    spawn,
    platform,
    execPath,
    requireResolve,
    pathEnv,
    pathDelimiter,
    dryRun,
    stdout,
    stderr,
  });
}

if (isExecutedAsMain(import.meta.url, process.argv[1])) {
  try {
    const dryRun = process.argv.includes("--check");
    process.exitCode = await applyHostedMigrations({ dryRun });
  } catch (error) {
    process.stderr.write(`${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
