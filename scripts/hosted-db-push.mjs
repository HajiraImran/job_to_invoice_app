import { spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
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
const SAFE_SPAWN_CODES = new Set(["EINVAL", "ENOENT", "EACCES", "EPERM"]);
const localRequire = createRequire(import.meta.url);

export function hostedDbPushArgv(url) {
  return ["db", "push", "--db-url", url];
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
    platform = process.platform,
    execPath = process.execPath,
    requireResolve,
    pathEnv,
    pathDelimiter,
  } = {},
) {
  const cliArgv = hostedDbPushArgv(url);
  const spawnOptions = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  };
  if (platform === "win32") {
    const jsEntry = resolveSupabaseJsEntry({ requireResolve, pathEnv, pathDelimiter });
    return {
      command: execPath,
      argv: [jsEntry, ...cliArgv],
      spawnOptions,
    };
  }
  return {
    command: "supabase",
    argv: cliArgv,
    spawnOptions,
  };
}

function spawnFailureMessage(error) {
  const code = error && typeof error.code === "string" && SAFE_SPAWN_CODES.has(error.code) ? error.code : null;
  if (code) {
    return `Failed to start the Supabase CLI for hosted apply (${code})`;
  }
  return "Failed to start the Supabase CLI for hosted apply";
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

function connectTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, family: 4 });
    const finish = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function assertIpv4SessionPoolerReachable(hostname) {
  if (!SESSION_POOLER_HOST.test(String(hostname ?? "").toLowerCase())) {
    throw new Error("D-012: hosted apply must use aws-0-<region>.pooler.supabase.com:5432");
  }
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (!records.some((row) => row.family === 4)) {
    throw new Error("D-012: session pooler has no IPv4 address");
  }
  const ok = await connectTcp(hostname, 5432, 8000);
  if (!ok) {
    throw new Error("D-012: IPv4 session pooler port 5432 is unreachable");
  }
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
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  const launch = hostedCliLaunch(url, {
    platform,
    execPath,
    requireResolve,
    pathEnv,
    pathDelimiter,
  });
  const result = spawn(launch.command, launch.argv, launch.spawnOptions);
  if (result.error) {
    throw new Error(spawnFailureMessage(result.error));
  }
  const out = redactCapturedOutput(result.stdout, url);
  const err = redactCapturedOutput(result.stderr, url);
  if (out) {
    stdout.write(out);
  }
  if (err) {
    stderr.write(err);
  }
  return result.status === null ? 1 : result.status;
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
  stdout = process.stdout,
  stderr = process.stderr,
  checkReachable = assertIpv4SessionPoolerReachable,
} = {}) {
  const expectedRef = readLinkedProjectRef(projectRefPath);
  const rawUrl = env.DATABASE_URL_MIGRATIONS;
  const url = typeof rawUrl === "string" ? rawUrl.trim() : rawUrl;
  const parsed = assertSafeHostedMigrationUrl(url, expectedRef);
  await checkReachable(parsed.hostname);
  return runHostedDbPush(url, {
    spawn,
    platform,
    execPath,
    requireResolve,
    pathEnv,
    pathDelimiter,
    stdout,
    stderr,
  });
}

if (isExecutedAsMain(import.meta.url, process.argv[1])) {
  try {
    process.exitCode = await applyHostedMigrations();
  } catch (error) {
    process.stderr.write(`${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
