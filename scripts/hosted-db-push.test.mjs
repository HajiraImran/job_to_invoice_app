import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyHostedMigrations,
  assertSafeHostedMigrationUrl,
  classifyHostedCliOutput,
  extractPendingMigrationBasenames,
  formatSanitizedReport,
  hostedCliLaunch,
  hostedDbPushArgv,
  isExecutedAsMain,
  readLinkedProjectRef,
  redactCapturedOutput,
  resolveSupabaseJsEntry,
  runHostedDbPush,
  splitSearchPath,
} from "./hosted-db-push.mjs";

const LINKED_REF = "abcdefghijklmnopabcd";
const OTHER_REF = "zzzzzzzzzzzzzzzzzzzz";
const HOST = "aws-0-us-west-2.pooler.supabase.com";
const PASSWORD = "unit-test-password";
const ENCODED_SPECIAL = "p%40ss%3Aw%2Frd%21-ok";
const DECODED_SPECIAL = "p@ss:w/rd!-ok";

function sessionUrl({
  protocol = "postgres",
  user = `postgres.${LINKED_REF}`,
  password = PASSWORD,
  host = HOST,
  port = ":5432",
  database = "/postgres",
  suffix = "",
} = {}) {
  return `${protocol}://${user}:${password}@${host}${port}${database}${suffix}`;
}

function writeJsEntry() {
  const dir = mkdtempSync(path.join(tmpdir(), "jti-js-"));
  const filePath = path.join(dir, "supabase.js");
  writeFileSync(filePath, "export {};\n");
  return realpathSync(filePath);
}

function writeNpmShimLayout() {
  const prefix = mkdtempSync(path.join(tmpdir(), "jti-shim-"));
  writeFileSync(path.join(prefix, "supabase.cmd"), "@echo off\r\n");
  const dist = path.join(prefix, "node_modules", "supabase", "dist");
  mkdirSync(dist, { recursive: true });
  const jsPath = path.join(dist, "supabase.js");
  writeFileSync(jsPath, "export {};\n");
  return { prefix, jsPath: realpathSync(jsPath) };
}

function writeRefFile(contents) {
  const dir = mkdtempSync(path.join(tmpdir(), "jti-ref-"));
  const filePath = path.join(dir, "project-ref");
  if (contents !== null) {
    writeFileSync(filePath, contents);
  }
  return filePath;
}

function captureWriters() {
  const stdout = [];
  const stderr = [];
  return {
    stdout: { write(chunk) { stdout.push(String(chunk)); } },
    stderr: { write(chunk) { stderr.push(String(chunk)); } },
    stdoutText: () => stdout.join(""),
    stderrText: () => stderr.join(""),
  };
}

test("rejects missing url", () => {
  assert.throws(() => assertSafeHostedMigrationUrl(undefined, LINKED_REF), /required/);
  assert.throws(() => assertSafeHostedMigrationUrl("", LINKED_REF), /required/);
});

test("rejects missing and empty linked project-ref file", () => {
  const missing = path.join(mkdtempSync(path.join(tmpdir(), "jti-ref-")), "project-ref");
  assert.throws(() => readLinkedProjectRef(missing), /missing or unreadable/);
  assert.throws(() => readLinkedProjectRef(writeRefFile("")), /empty/);
  assert.throws(() => readLinkedProjectRef(writeRefFile("   \n")), /empty/);
});

test("rejects malformed linked project-ref", () => {
  assert.throws(() => readLinkedProjectRef(writeRefFile("not-a-ref")), /malformed/);
  assert.throws(() => readLinkedProjectRef(writeRefFile("ABCDEFGHIJABCDEFGHIJ")), /malformed/);
  assert.throws(() => readLinkedProjectRef(writeRefFile("abcdefghijklmnopabc")), /malformed/);
  assert.throws(() => readLinkedProjectRef(writeRefFile(`${LINKED_REF}x`)), /malformed/);
});

test("reads a valid linked project-ref", () => {
  assert.equal(readLinkedProjectRef(writeRefFile(`\n${LINKED_REF}\n`)), LINKED_REF);
});

test("accepts a URL that matches the linked project-ref", () => {
  const parsed = assertSafeHostedMigrationUrl(sessionUrl(), LINKED_REF);
  assert.equal(parsed.port, "5432");
  assert.equal(parsed.hostname, HOST);
  assert.equal(parsed.username, `postgres.${LINKED_REF}`);
});

test("accepts postgresql:// and percent-encoded passwords", () => {
  const parsed = assertSafeHostedMigrationUrl(
    sessionUrl({ protocol: "postgresql", password: ENCODED_SPECIAL }),
    LINKED_REF,
  );
  assert.equal(parsed.password, ENCODED_SPECIAL);
  assert.equal(decodeURIComponent(parsed.password), DECODED_SPECIAL);
});

test("rejects a username for a different project ref", () => {
  assert.throws(
    () => assertSafeHostedMigrationUrl(sessionUrl({ user: `postgres.${OTHER_REF}` }), LINKED_REF),
    /linked-project-ref/,
  );
});

test("rejects invalid usernames", () => {
  assert.throws(
    () => assertSafeHostedMigrationUrl(sessionUrl({ user: "postgres" }), LINKED_REF),
    /linked-project-ref/,
  );
  assert.throws(
    () => assertSafeHostedMigrationUrl(sessionUrl({ user: "postgres." }), LINKED_REF),
    /linked-project-ref/,
  );
  assert.throws(
    () => assertSafeHostedMigrationUrl(sessionUrl({ user: `api.${LINKED_REF}` }), LINKED_REF),
    /linked-project-ref/,
  );
});

test("does not accept an environment project ref that disagrees with the linked file", async () => {
  const previous = process.env.SUPABASE_PROJECT_REF;
  process.env.SUPABASE_PROJECT_REF = OTHER_REF;
  try {
    const captured = captureWriters();
    let spawned = 0;
    const status = await applyHostedMigrations({
      env: { DATABASE_URL_MIGRATIONS: sessionUrl(), SUPABASE_PROJECT_REF: OTHER_REF },
      projectRefPath: writeRefFile(LINKED_REF),
      platform: "linux",
      checkReachable: async () => {},
      spawn: () => {
        spawned += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
      stdout: captured.stdout,
      stderr: captured.stderr,
    });
    assert.equal(status, 0);
    assert.equal(spawned, 1);
    await assert.rejects(
      () =>
        applyHostedMigrations({
          env: {
            DATABASE_URL_MIGRATIONS: sessionUrl({ user: `postgres.${OTHER_REF}` }),
            SUPABASE_PROJECT_REF: OTHER_REF,
          },
          projectRefPath: writeRefFile(LINKED_REF),
          checkReachable: async () => {},
          spawn: () => {
            throw new Error("spawn must not run");
          },
        }),
      /linked-project-ref/,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.SUPABASE_PROJECT_REF;
    } else {
      process.env.SUPABASE_PROJECT_REF = previous;
    }
  }
});

test("rejects the direct database host", () => {
  assert.throws(
    () =>
      assertSafeHostedMigrationUrl(
        sessionUrl({ host: `db.${LINKED_REF}.supabase.co` }),
        LINKED_REF,
      ),
    /IPv6-only/,
  );
});

test("rejects an omitted port", () => {
  assert.throws(
    () => assertSafeHostedMigrationUrl(sessionUrl({ port: "" }), LINKED_REF),
    /explicit/,
  );
});

test("rejects transaction pooler port 6543", () => {
  assert.throws(
    () => assertSafeHostedMigrationUrl(sessionUrl({ port: ":6543" }), LINKED_REF),
    /6543/,
  );
});

test("rejects invalid and malicious pooler hosts", () => {
  for (const host of [
    "evil.pooler.supabase.com",
    "aws-0-us-west-2.evil.pooler.supabase.com",
    "aws-0-us-west-2.pooler.supabase.com.evil.com",
    "pooler.supabase.com",
    "localhost",
    "127.0.0.1",
    "example.com",
  ]) {
    assert.throws(
      () => assertSafeHostedMigrationUrl(sessionUrl({ host }), LINKED_REF),
      /aws-0-<region>\.pooler\.supabase\.com/,
    );
  }
});

function thrownMessage(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
  assert.fail("expected an error");
}

test("rejects a privileged role", () => {
  const role = ["service", "role"].join("_");
  const message = thrownMessage(() =>
    assertSafeHostedMigrationUrl(sessionUrl({ user: role }), LINKED_REF),
  );
  assert.match(message, /privileged/);
  assert.doesNotMatch(message, new RegExp(PASSWORD));
});

test("rejects an empty password", () => {
  assert.throws(
    () =>
      assertSafeHostedMigrationUrl(
        `postgres://postgres.${LINKED_REF}:@${HOST}:5432/postgres`,
        LINKED_REF,
      ),
    /password/,
  );
  assert.throws(
    () =>
      assertSafeHostedMigrationUrl(
        `postgres://postgres.${LINKED_REF}@${HOST}:5432/postgres`,
        LINKED_REF,
      ),
    /password/,
  );
});

test("rejects query parameters incompatible with session SET ROLE", () => {
  assert.throws(
    () => assertSafeHostedMigrationUrl(sessionUrl({ suffix: "?pgbouncer=true" }), LINKED_REF),
    /query parameters/,
  );
  assert.throws(
    () => assertSafeHostedMigrationUrl(sessionUrl({ suffix: "?sslmode=require" }), LINKED_REF),
    /query parameters/,
  );
});

test("command-injection strings remain one inert argv value", () => {
  const injection = `${PASSWORD}; calc.exe & echo`;
  const url = sessionUrl({ password: encodeURIComponent(injection) });
  assertSafeHostedMigrationUrl(url, LINKED_REF);
  const argv = hostedDbPushArgv(url);
  assert.deepEqual(argv, ["db", "push", "--db-url", url]);
  assert.ok(!argv.includes("--dry-run"));
  const jsEntry = writeJsEntry();
  let spawned = 0;
  const captured = captureWriters();
  const status = runHostedDbPush(url, {
    platform: "win32",
    execPath: process.execPath,
    requireResolve: () => jsEntry,
    spawn: (bin, receivedArgv, options) => {
      spawned += 1;
      assert.equal(bin, process.execPath);
      assert.equal(receivedArgv.length, 5);
      assert.equal(receivedArgv[4], url);
      assert.ok(!receivedArgv.includes("--dry-run"));
      assert.equal(options.shell, false);
      return { status: 0, stdout: "", stderr: "" };
    },
    stdout: captured.stdout,
    stderr: captured.stderr,
  });
  assert.equal(status, 0);
  assert.equal(spawned, 1);
});

test("redacts credentials from stdout, stderr, and thrown errors", () => {
  const url = sessionUrl({ password: ENCODED_SPECIAL });
  const captured = captureWriters();
  runHostedDbPush(url, {
    platform: "linux",
    spawn: () => ({
      status: 1,
      stdout: `connected ${url} password=${DECODED_SPECIAL}\n`,
      stderr: `postgresql://postgres.${LINKED_REF}:${ENCODED_SPECIAL}@${HOST}:5432/postgres boom\n`,
    }),
    stdout: captured.stdout,
    stderr: captured.stderr,
  });
  const combined = `${captured.stdoutText()}${captured.stderrText()}`;
  assert.match(combined, /ok: false/);
  assert.doesNotMatch(combined, /connected /);
  assert.doesNotMatch(combined, /boom/);
  assert.doesNotMatch(combined, new RegExp(PASSWORD));
  assert.doesNotMatch(combined, /p%40ss/);
  assert.doesNotMatch(combined, /p@ss:w\/rd/);
  assert.doesNotMatch(combined, /postgres(ql)?:\/\//i);

  const redacted = redactCapturedOutput(`using ${url} and ${DECODED_SPECIAL}`, url);
  assert.doesNotMatch(redacted, /p%40ss/);
  assert.doesNotMatch(redacted, /p@ss:w\/rd/);

  const message = thrownMessage(() =>
    assertSafeHostedMigrationUrl(sessionUrl({ password: PASSWORD, host: "evil.example" }), LINKED_REF),
  );
  assert.match(message, /pooler/);
  assert.doesNotMatch(message, new RegExp(PASSWORD));
  assert.doesNotMatch(message, /postgres:\/\//);
});

test("omits output when credentials cannot be redacted safely", () => {
  const shortUrl = sessionUrl({ password: "short" });
  const redacted = redactCapturedOutput(`leak ${shortUrl}`, shortUrl);
  assert.equal(
    redacted,
    "hosted apply output omitted because credentials cannot be redacted safely",
  );
});

test("Windows launches the resolved JS entry through process.execPath", () => {
  const url = sessionUrl();
  const jsEntry = writeJsEntry();
  const launch = hostedCliLaunch(url, {
    platform: "win32",
    execPath: process.execPath,
    requireResolve: () => jsEntry,
  });
  assert.equal(launch.command, process.execPath);
  assert.doesNotMatch(launch.command, /supabase\.cmd|supabase\.ps1|cmd\.exe|powershell/i);
  assert.deepEqual(launch.argv, [jsEntry, "db", "push", "--db-url", url]);
  assert.equal(launch.spawnOptions.shell, false);
  assert.equal(launch.spawnOptions.windowsHide, true);
});

test("non-Windows launch remains supabase with db push argv", () => {
  const url = sessionUrl();
  const launch = hostedCliLaunch(url, { platform: "linux" });
  assert.equal(launch.command, "supabase");
  assert.deepEqual(launch.argv, ["db", "push", "--db-url", url]);
  assert.equal(launch.spawnOptions.shell, false);
  const darwin = hostedCliLaunch(url, { platform: "darwin" });
  assert.equal(darwin.command, "supabase");
  assert.deepEqual(darwin.argv, ["db", "push", "--db-url", url]);
});

test("local package resolution is preferred over PATH shims", () => {
  const localJs = writeJsEntry();
  const shim = writeNpmShimLayout();
  const resolved = resolveSupabaseJsEntry({
    requireResolve: () => localJs,
    pathEnv: shim.prefix,
    pathDelimiter: path.delimiter,
  });
  assert.equal(resolved, localJs);
});

test("valid global npm shim layout is used when the package is not resolvable", () => {
  const shim = writeNpmShimLayout();
  const quoted = `"${shim.prefix}"`;
  const resolved = resolveSupabaseJsEntry({
    requireResolve: () => {
      throw Object.assign(new Error("not found"), { code: "MODULE_NOT_FOUND" });
    },
    pathEnv: `${quoted}${path.delimiter}C:\\Windows\\System32`,
    pathDelimiter: path.delimiter,
  });
  assert.equal(resolved, shim.jsPath);
});

test("missing JS entry fails closed without spawning", () => {
  let spawned = 0;
  const message = thrownMessage(() =>
    runHostedDbPush(sessionUrl(), {
      platform: "win32",
      requireResolve: () => {
        throw Object.assign(new Error("not found"), { code: "MODULE_NOT_FOUND" });
      },
      pathEnv: "",
      spawn: () => {
        spawned += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    }),
  );
  assert.match(message, /could not be resolved/);
  assert.doesNotMatch(message, new RegExp(PASSWORD));
  assert.doesNotMatch(message, /postgres:\/\//);
  assert.equal(spawned, 0);
});

test("malformed PATH entries fail safely", () => {
  assert.deepEqual(splitSearchPath(';;;"";;', ";"), []);
  assert.deepEqual(splitSearchPath('"C:\\quoted', ";"), []);
  const message = thrownMessage(() =>
    resolveSupabaseJsEntry({
      requireResolve: () => {
        throw new Error("not found");
      },
      pathEnv: `;;;"C:\\nope;;${path.join(tmpdir(), "missing-shim")};;`,
      pathDelimiter: ";",
    }),
  );
  assert.match(message, /could not be resolved/);
  assert.doesNotMatch(message, /C:\\nope/);
  assert.doesNotMatch(message, /missing-shim/);
});

test("main guard matches resolved, relative, and Windows path forms", () => {
  const modulePath = fileURLToPath(new URL("./hosted-db-push.mjs", import.meta.url));
  const meta = pathToFileURL(modulePath).href;
  const relativePath = path.relative(process.cwd(), modulePath);
  assert.equal(isExecutedAsMain(meta, modulePath), true);
  assert.equal(isExecutedAsMain(meta, relativePath), true);
  assert.equal(isExecutedAsMain(meta, modulePath.replaceAll("\\", "/"), "win32"), true);
  assert.equal(isExecutedAsMain(meta, modulePath.toUpperCase(), "win32"), true);
  assert.equal(isExecutedAsMain(meta, pathToFileURL(modulePath).href), true);
  assert.equal(isExecutedAsMain(meta, fileURLToPath(import.meta.url)), false);
  assert.equal(isExecutedAsMain(meta, undefined), false);
  assert.equal(isExecutedAsMain(meta, ""), false);
});

test("spawns exactly once with the validated URL and does not retry", async () => {
  const url = sessionUrl();
  const captured = captureWriters();
  let spawned = 0;
  const status = await applyHostedMigrations({
    env: { DATABASE_URL_MIGRATIONS: url },
    projectRefPath: writeRefFile(LINKED_REF),
    platform: "linux",
    checkReachable: async (hostname) => {
      assert.equal(hostname, HOST);
    },
    spawn: (bin, argv, options) => {
      spawned += 1;
      assert.equal(bin, "supabase");
      assert.deepEqual(argv, ["db", "push", "--db-url", url]);
      assert.equal(options.shell, false);
      assert.doesNotMatch(argv.join(" "), /include-all|include-roles|include-seed|--linked|--dry-run/);
      return { status: 1, stdout: "failed once", stderr: "" };
    },
    stdout: captured.stdout,
    stderr: captured.stderr,
  });
  assert.equal(status, 1);
  assert.equal(spawned, 1);
});

test("Windows spawns node once with the JS entry and does not retry", async () => {
  const url = sessionUrl();
  const jsEntry = writeJsEntry();
  const captured = captureWriters();
  let spawned = 0;
  const status = await applyHostedMigrations({
    env: { DATABASE_URL_MIGRATIONS: url },
    projectRefPath: writeRefFile(LINKED_REF),
    platform: "win32",
    execPath: process.execPath,
    requireResolve: () => jsEntry,
    checkReachable: async () => {},
    spawn: (bin, argv, options) => {
      spawned += 1;
      assert.equal(bin, process.execPath);
      assert.deepEqual(argv, [jsEntry, "db", "push", "--db-url", url]);
      assert.equal(options.shell, false);
      assert.ok(!argv.includes("--dry-run"));
      assert.equal(options.windowsHide, true);
      return { status: 1, stdout: "failed once", stderr: "" };
    },
    stdout: captured.stdout,
    stderr: captured.stderr,
  });
  assert.equal(status, 1);
  assert.equal(spawned, 1);
});

test("does not spawn when validation fails and reports spawn failures without argv", async () => {
  let spawned = 0;
  const spawn = () => {
    spawned += 1;
    return { status: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(
    () =>
      applyHostedMigrations({
        env: {},
        projectRefPath: writeRefFile(LINKED_REF),
        spawn,
        checkReachable: async () => {},
      }),
    /required/,
  );
  const captured = captureWriters();
  const status = runHostedDbPush(sessionUrl(), {
    platform: "win32",
    execPath: process.execPath,
    requireResolve: () => writeJsEntry(),
    stdout: captured.stdout,
    stderr: captured.stderr,
    spawn: () => {
      spawned += 1;
      const failure = new Error("spawn EINVAL");
      failure.code = "EINVAL";
      failure.spawnargs = [process.execPath, "db", "push", "--db-url", sessionUrl()];
      failure.path = process.execPath;
      return { error: failure, status: null, stdout: "", stderr: "" };
    },
  });
  const message = captured.stdoutText();
  assert.equal(status, 1);
  assert.match(message, /category: cli_start_failure/);
  assert.match(message, /code: EINVAL/);
  assert.doesNotMatch(message, /--db-url/);
  assert.doesNotMatch(message, /spawnargs/);
  assert.doesNotMatch(message, new RegExp(PASSWORD));
  assert.doesNotMatch(message, /postgres:\/\//);
  const enoentOut = captureWriters();
  const enoentStatus = runHostedDbPush(sessionUrl(), {
    platform: "linux",
    stdout: enoentOut.stdout,
    stderr: enoentOut.stderr,
    spawn: () => {
      spawned += 1;
      const failure = new Error("spawn ENOENT");
      failure.code = "ENOENT";
      failure.spawnargs = ["supabase", "db", "push", "--db-url", sessionUrl()];
      return { error: failure, status: null, stdout: "", stderr: "" };
    },
  });
  assert.equal(enoentStatus, 1);
  assert.match(enoentOut.stdoutText(), /code: ENOENT/);
  assert.doesNotMatch(enoentOut.stdoutText(), new RegExp(PASSWORD));
  assert.equal(spawned, 2);
});

test("does not spawn when the pooler is unreachable", async () => {
  let spawned = 0;
  await assert.rejects(
    () =>
      applyHostedMigrations({
        env: { DATABASE_URL_MIGRATIONS: sessionUrl() },
        projectRefPath: writeRefFile(LINKED_REF),
        checkReachable: async () => {
          throw new Error("D-012: IPv4 session pooler port 5432 is unreachable");
        },
        spawn: () => {
          spawned += 1;
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    /unreachable/,
  );
  assert.equal(spawned, 0);
});

test("db-check always includes --dry-run and live push never does", async () => {
  const url = sessionUrl();
  assert.deepEqual(hostedDbPushArgv(url), ["db", "push", "--db-url", url]);
  assert.deepEqual(hostedDbPushArgv(url, { dryRun: true }), [
    "db",
    "push",
    "--db-url",
    url,
    "--dry-run",
  ]);
  let liveSpawned = 0;
  let checkSpawned = 0;
  await applyHostedMigrations({
    env: { DATABASE_URL_MIGRATIONS: url },
    projectRefPath: writeRefFile(LINKED_REF),
    platform: "linux",
    dryRun: false,
    checkReachable: async () => {},
    spawn: (_bin, argv, options) => {
      liveSpawned += 1;
      assert.deepEqual(argv, ["db", "push", "--db-url", url]);
      assert.ok(!argv.includes("--dry-run"));
      assert.equal(options.shell, false);
      return {
        status: 0,
        stdout: "Finished supabase db push.\nRemote database is up to date.\n",
        stderr: "",
      };
    },
    stdout: captureWriters().stdout,
    stderr: captureWriters().stderr,
  });
  await applyHostedMigrations({
    env: { DATABASE_URL_MIGRATIONS: url },
    projectRefPath: writeRefFile(LINKED_REF),
    platform: "linux",
    dryRun: true,
    checkReachable: async () => {},
    spawn: (_bin, argv, options) => {
      checkSpawned += 1;
      assert.deepEqual(argv, ["db", "push", "--db-url", url, "--dry-run"]);
      assert.equal(argv.filter((part) => part === "--dry-run").length, 1);
      assert.equal(options.shell, false);
      return {
        status: 0,
        stdout:
          "Initialising login role...\nConnecting to remote database...\nWould apply the following migrations:\n  - 0002_identity_tenancy.sql\n  - 0003_owner_provisioning.sql\n  - 0004_workspace_setup.sql\n",
        stderr: "",
      };
    },
    stdout: captureWriters().stdout,
    stderr: captureWriters().stderr,
  });
  assert.equal(liveSpawned, 1);
  assert.equal(checkSpawned, 1);
});

test("Windows dry-run check uses node.exe and one --dry-run argument", () => {
  const url = sessionUrl();
  const jsEntry = writeJsEntry();
  const launch = hostedCliLaunch(url, {
    platform: "win32",
    execPath: process.execPath,
    requireResolve: () => jsEntry,
    dryRun: true,
  });
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.argv, [jsEntry, "db", "push", "--db-url", url, "--dry-run"]);
  assert.equal(launch.spawnOptions.shell, false);
});

test("classifies every safe failure category", () => {
  const cases = [
    ["password authentication failed for user 28P01", "authentication_failed", "28P01"],
    ["PgClient: Connection timed out ETIMEDOUT LegacyDbConnectError", "connection_timeout", "ETIMEDOUT"],
    ["could not connect: connection refused ECONNREFUSED", "connection_refused", "ECONNREFUSED"],
    ["getaddrinfo ENOTFOUND", "dns_failure", "ENOTFOUND"],
    ["SSL error: certificate verify failed", "tls_failure", null],
    [
      "LegacyDbPushApplyError ERROR: permission denied at character 13 SQLSTATE 42501",
      "migration_sql_error",
      "42501",
    ],
  ];
  for (const [stderr, category, code] of cases) {
    const classified = classifyHostedCliOutput({ status: 1, stdout: "", stderr });
    assert.equal(classified.ok, false);
    assert.equal(classified.category, category);
    if (code) {
      assert.equal(classified.code, code);
    }
  }
  const start = classifyHostedCliOutput({
    status: null,
    stdout: "",
    stderr: "",
    spawnError: Object.assign(new Error("spawn"), { code: "EINVAL" }),
  });
  assert.equal(start.category, "cli_start_failure");
  assert.equal(start.code, "EINVAL");
  const unknown = classifyHostedCliOutput({
    status: 1,
    stdout: "",
    stderr: "unexpected internal panic",
  });
  assert.equal(unknown.category, "unknown_failure");
  assert.equal(unknown.code, null);
});

test("unknown output and secrets are not echoed in the sanitized report", () => {
  const url = sessionUrl({ password: ENCODED_SPECIAL });
  const classified = classifyHostedCliOutput({
    status: 1,
    stdout: `steal ${url} user=postgres.${LINKED_REF} SELECT * FROM pg_authid; DROP TABLE identity.app_users;`,
    stderr: `password=${DECODED_SPECIAL} argv --db-url ${url}`,
  });
  const report = formatSanitizedReport(classified);
  assert.match(report, /ok: false/);
  assert.match(report, /category: unknown_failure/);
  assert.doesNotMatch(report, /steal/);
  assert.doesNotMatch(report, /pg_authid/);
  assert.doesNotMatch(report, /DROP TABLE/);
  assert.doesNotMatch(report, /--db-url/);
  assert.doesNotMatch(report, /argv/);
  assert.doesNotMatch(report, new RegExp(PASSWORD));
  assert.doesNotMatch(report, /p%40ss/);
  assert.doesNotMatch(report, /p@ss:w\/rd/);
  assert.doesNotMatch(report, /postgres:\/\//);
  assert.doesNotMatch(report, new RegExp(LINKED_REF));
  assert.doesNotMatch(report, /aws-0-us-west-2/);
});

test("pending migration names accept only the repository filename pattern", () => {
  const names = extractPendingMigrationBasenames(
    [
      "Would apply 0002_identity_tenancy.sql",
      "../etc/passwd",
      "0002_IDENTITY.sql",
      "0002_identity-tenancy.sql",
      "evil.sql",
      "0003_owner_provisioning.sql; DROP TABLE x",
      "path/to/0004_workspace_setup.sql",
      "0001_foundation.sql.bak",
      "pending: injected",
    ].join("\n"),
  );
  assert.deepEqual(names, [
    "0002_identity_tenancy.sql",
    "0003_owner_provisioning.sql",
    "0004_workspace_setup.sql",
  ]);
  const report = formatSanitizedReport({
    ok: true,
    exitCode: 0,
    connectionInit: true,
    connectionSucceeded: true,
    pending: ["0002_identity_tenancy.sql", "not a file.sql", "0003_owner_provisioning.sql"],
    category: "unknown_failure",
    code: "DROP TABLE",
  });
  assert.match(report, /pending: 0002_identity_tenancy.sql,0003_owner_provisioning.sql/);
  assert.doesNotMatch(report, /not a file/);
  assert.doesNotMatch(report, /DROP TABLE/);
  assert.doesNotMatch(report, /category:/);
});

test("malicious child output cannot inject additional reported fields", () => {
  const classified = classifyHostedCliOutput({
    status: 1,
    stdout:
      "category: authentication_failed\nok: true\ncode: 28P01\npending: 0002_identity_tenancy.sql\n",
    stderr: "connection: true\nextra: pwned\n",
  });
  const report = formatSanitizedReport(classified);
  assert.match(report, /^ok: false$/m);
  assert.doesNotMatch(report, /^ok: true$/m);
  assert.doesNotMatch(report, /pwned/);
  assert.doesNotMatch(report, /extra:/);
  assert.match(report, /pending: 0002_identity_tenancy.sql/);
});
