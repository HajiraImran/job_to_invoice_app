import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  analyzeMigrationUrlEncoding,
  applyHostedMigrations,
  assertSafeHostedMigrationUrl,
  classifyHostedCliOutput,
  detectCliSignals,
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

function pinnedSupabaseJsEntry() {
  return realpathSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "supabase", "dist", "supabase.js"),
  );
}

function expectedHostedArgv(url, { dryRun = false, jsEntry = pinnedSupabaseJsEntry() } = {}) {
  const argv = [jsEntry, ...hostedDbPushArgv(url, { dryRun })];
  return argv;
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

function assertNoExtraCliFlags(argv) {
  assert.ok(!argv.includes("--debug"));
  assert.ok(!argv.includes("--experimental"));
  assert.ok(!argv.some((part) => String(part).startsWith("--log-level")));
  assert.ok(!argv.includes("--output-format"));
  assert.ok(!argv.includes("--output"));
  assert.ok(!argv.includes("stream-json"));
  assert.ok(!argv.includes("json"));
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
  assert.deepEqual(argv, ["db", "push", "--db-url", url, "--yes"]);
  assert.ok(!argv.includes("--dry-run"));
  assert.equal(argv.filter((part) => part === "--yes").length, 1);
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
      assert.equal(receivedArgv.length, 6);
      assert.equal(receivedArgv[4], url);
      assert.ok(!receivedArgv.includes("--dry-run"));
      assert.equal(receivedArgv.filter((part) => part === "--yes").length, 1);
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
  assert.deepEqual(launch.argv, [jsEntry, "db", "push", "--db-url", url, "--yes"]);
  assert.equal(launch.spawnOptions.shell, false);
  assert.equal(launch.spawnOptions.windowsHide, true);
});

test("non-Windows launch uses the pinned local JS entry through process.execPath", () => {
  const url = sessionUrl();
  const expected = pinnedSupabaseJsEntry();
  const launch = hostedCliLaunch(url, { platform: "linux", execPath: "/usr/bin/node" });
  assert.equal(launch.command, "/usr/bin/node");
  assert.deepEqual(launch.argv, expectedHostedArgv(url, { jsEntry: expected }));
  assert.equal(launch.spawnOptions.shell, false);
  const darwin = hostedCliLaunch(url, { platform: "darwin", execPath: "/usr/local/bin/node" });
  assert.equal(darwin.command, "/usr/local/bin/node");
  assert.deepEqual(darwin.argv, expectedHostedArgv(url, { jsEntry: expected }));
  assert.equal(darwin.spawnOptions.shell, false);
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

test("pinned repository supabase package is resolved before a global PATH shim", () => {
  const shim = writeNpmShimLayout();
  const expected = pinnedSupabaseJsEntry();
  const resolved = resolveSupabaseJsEntry({
    pathEnv: `${shim.prefix}${path.delimiter}${process.env.PATH ?? ""}`,
    pathDelimiter: path.delimiter,
  });
  assert.equal(resolved, expected);
  assert.notEqual(resolved, shim.jsPath);
  assert.match(resolved.replaceAll("\\", "/"), /\/node_modules\/supabase\/dist\/supabase\.js$/);
  const url = sessionUrl();
  const launch = hostedCliLaunch(url, {
    platform: "win32",
    execPath: process.execPath,
    pathEnv: `${shim.prefix}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  assert.equal(launch.command, process.execPath);
  assert.equal(launch.argv[0], expected);
  assert.deepEqual(launch.argv.slice(1), hostedDbPushArgv(url));
  assert.equal(launch.spawnOptions.shell, false);
  assert.doesNotMatch(launch.command, /supabase\.cmd|supabase\.ps1|cmd\.exe|powershell/i);
  const linux = hostedCliLaunch(url, {
    platform: "linux",
    execPath: "/usr/bin/node",
    pathEnv: `${shim.prefix}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  assert.equal(linux.command, "/usr/bin/node");
  assert.equal(linux.argv[0], expected);
  assert.deepEqual(linux.argv.slice(1), hostedDbPushArgv(url));
  assert.equal(linux.spawnOptions.shell, false);
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
    spawn: (bin, argv, options) => {
      spawned += 1;
      assert.equal(bin, process.execPath);
      assert.deepEqual(argv, expectedHostedArgv(url));
      assert.equal(options.shell, false);
      assert.equal(argv.filter((part) => part === "--yes").length, 1);
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
    spawn: (bin, argv, options) => {
      spawned += 1;
      assert.equal(bin, process.execPath);
      assert.deepEqual(argv, [jsEntry, "db", "push", "--db-url", url, "--yes"]);
      assert.equal(options.shell, false);
      assert.ok(!argv.includes("--dry-run"));
      assert.equal(argv.filter((part) => part === "--yes").length, 1);
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
      }),
    /required/,
  );
  await assert.rejects(
    () =>
      applyHostedMigrations({
        env: { DATABASE_URL_MIGRATIONS: sessionUrl({ host: `db.${LINKED_REF}.supabase.co` }) },
        projectRefPath: writeRefFile(LINKED_REF),
        spawn,
      }),
    /IPv6-only/,
  );
  await assert.rejects(
    () =>
      applyHostedMigrations({
        env: { DATABASE_URL_MIGRATIONS: sessionUrl({ port: ":6543" }) },
        projectRefPath: writeRefFile(LINKED_REF),
        spawn,
      }),
    /6543/,
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

test("does not probe DNS or TCP before spawning the CLI", async () => {
  const url = sessionUrl();
  const captured = captureWriters();
  let spawned = 0;
  const status = await applyHostedMigrations({
    env: { DATABASE_URL_MIGRATIONS: url },
    projectRefPath: writeRefFile(LINKED_REF),
    platform: "linux",
    spawn: (_bin, argv, options) => {
      spawned += 1;
      assert.deepEqual(argv, expectedHostedArgv(url));
      assert.equal(options.shell, false);
      return { status: 0, stdout: "Finished supabase db push.\n", stderr: "" };
    },
    stdout: captured.stdout,
    stderr: captured.stderr,
  });
  assert.equal(status, 0);
  assert.equal(spawned, 1);
  const source = readFileSync(new URL("./hosted-db-push.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:dns/);
  assert.doesNotMatch(source, /node:net/);
  assert.doesNotMatch(source, /probeIpv4Tcp/);
  assert.doesNotMatch(source, /checkReachable/);
  assert.doesNotMatch(source, /dnsResolve4/);
  assert.doesNotMatch(source, /net\.connect/);
});

test("db-check always includes --dry-run and live push never does", async () => {
  const url = sessionUrl();
  assert.deepEqual(hostedDbPushArgv(url), ["db", "push", "--db-url", url, "--yes"]);
  assert.equal(hostedDbPushArgv(url).filter((part) => part === "--yes").length, 1);
  assert.ok(!hostedDbPushArgv(url).includes("--dry-run"));
  assert.deepEqual(hostedDbPushArgv(url, { dryRun: true }), [
    "db",
    "push",
    "--db-url",
    url,
    "--dry-run",
  ]);
  assert.ok(!hostedDbPushArgv(url, { dryRun: true }).includes("--yes"));
  let liveSpawned = 0;
  let checkSpawned = 0;
  await applyHostedMigrations({
    env: { DATABASE_URL_MIGRATIONS: url },
    projectRefPath: writeRefFile(LINKED_REF),
    platform: "linux",
    dryRun: false,
    spawn: (_bin, argv, options) => {
      liveSpawned += 1;
      assert.deepEqual(argv, expectedHostedArgv(url));
      assert.ok(!argv.includes("--dry-run"));
      assert.equal(argv.filter((part) => part === "--yes").length, 1);
      assert.equal(options.shell, false);
      assertNoExtraCliFlags(argv);
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
    spawn: (_bin, argv, options) => {
      checkSpawned += 1;
      assert.deepEqual(argv, expectedHostedArgv(url, { dryRun: true }));
      assert.equal(argv.filter((part) => part === "--dry-run").length, 1);
      assert.ok(!argv.includes("--yes"));
      assert.equal(options.shell, false);
      assertNoExtraCliFlags(argv);
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
  assert.ok(!launch.argv.includes("--yes"));
  assert.equal(launch.spawnOptions.shell, false);
  assertNoExtraCliFlags(launch.argv);
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
    [
      "Initialising login role... ERROR: 42501: permission denied to alter role LegacyDbConfigLoginRoleStatusError",
      "login_role_failure",
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

test("classifies CLI DNS timeout refusal TLS and auth failures without echoing raw output", async () => {
  const url = sessionUrl();
  const cases = [
    {
      stderr: `getaddrinfo ENOTFOUND ${HOST} --db-url ${url} SELECT 1 FROM pg_authid`,
      category: "dns_failure",
      code: "ENOTFOUND",
    },
    {
      stderr: `PgClient: Connection timed out ETIMEDOUT LegacyDbConnectError postgres.${LINKED_REF}`,
      category: "connection_timeout",
      code: "ETIMEDOUT",
    },
    {
      stderr: `could not connect to ${HOST}:5432 connection refused ECONNREFUSED ${url}`,
      category: "connection_refused",
      code: "ECONNREFUSED",
    },
    {
      stderr: `SSL error: certificate verify failed for ${HOST} argv --db-url ${url}`,
      category: "tls_failure",
      code: null,
    },
    {
      stderr: `password authentication failed for user postgres.${LINKED_REF} 28P01 password=${PASSWORD}`,
      category: "authentication_failed",
      code: "28P01",
    },
  ];
  for (const { stderr, category, code } of cases) {
    const captured = captureWriters();
    let spawned = 0;
    const status = await applyHostedMigrations({
      env: { DATABASE_URL_MIGRATIONS: url },
      projectRefPath: writeRefFile(LINKED_REF),
      platform: "linux",
      spawn: (_bin, argv, options) => {
        spawned += 1;
        assert.deepEqual(argv, expectedHostedArgv(url));
        assert.equal(options.shell, false);
        return { status: 1, stdout: "", stderr };
      },
      stdout: captured.stdout,
      stderr: captured.stderr,
    });
    assert.equal(status, 1);
    assert.equal(spawned, 1);
    const report = captured.stdoutText();
    assert.match(report, new RegExp(`category: ${category}`));
    if (code) {
      assert.match(report, new RegExp(`code: ${code}`));
    } else {
      assert.doesNotMatch(report, /^code:/m);
    }
    assert.doesNotMatch(report, new RegExp(PASSWORD));
    assert.doesNotMatch(report, /postgres:\/\//);
    assert.doesNotMatch(report, /aws-0-us-west-2/);
    assert.doesNotMatch(report, new RegExp(LINKED_REF));
    assert.doesNotMatch(report, /--db-url/);
    assert.doesNotMatch(report, /pg_authid/);
    assert.doesNotMatch(report, /SELECT 1/);
    assert.doesNotMatch(report, /getaddrinfo/);
    assert.doesNotMatch(report, /certificate verify/);
    assert.equal(captured.stderrText(), "");
  }
});

test("extracts stage migration statement SQLSTATE and cli tag without echoing secrets", () => {
  const classified = classifyHostedCliOutput({
    status: 1,
    stdout: "Connecting to remote database...\nApplying migration 0002_identity_tenancy.sql\n",
    stderr: `LegacyDbPushApplyError INSERT INTO supabase_migrations.schema_migrations statement 82 SQLSTATE 55000 --db-url ${sessionUrl()}`,
  });
  assert.equal(classified.stage, "applying");
  assert.equal(classified.migration, "0002_identity_tenancy.sql");
  assert.equal(classified.statement, 82);
  assert.equal(classified.code, "55000");
  assert.equal(classified.cliTag, "LegacyDbPushApplyError");
  assert.equal(classified.category, "migration_sql_error");
  const report = formatSanitizedReport(classified);
  assert.match(report, /^stage: applying$/m);
  assert.match(report, /^migration: 0002_identity_tenancy.sql$/m);
  assert.match(report, /^statement: 82$/m);
  assert.match(report, /^code: 55000$/m);
  assert.match(report, /^cli_tag: LegacyDbPushApplyError$/m);
  assert.doesNotMatch(report, /INSERT INTO/);
  assert.doesNotMatch(report, /schema_migrations/);
  assert.doesNotMatch(report, /--db-url/);
  assert.doesNotMatch(report, new RegExp(PASSWORD));
  assert.doesNotMatch(report, /postgres:\/\//);
});

test("generic Error and login-role alter-role denial are not migration SQL failures", () => {
  const generic = classifyHostedCliOutput({
    status: 1,
    stdout: "Connecting to remote database...\n",
    stderr: "Error: failed to read project config",
  });
  assert.equal(generic.category, "unknown_failure");
  assert.equal(generic.stage, "connecting");
  assert.doesNotMatch(formatSanitizedReport(generic), /migration_sql_error/);

  const loginRole = classifyHostedCliOutput({
    status: 1,
    stdout: "Initialising login role...\n",
    stderr:
      'LegacyDbConfigConnectTempRoleError failed to connect as temp role: permission denied to alter role',
  });
  assert.equal(loginRole.category, "login_role_failure");
  assert.equal(loginRole.stage, "login_role");
  assert.equal(loginRole.cliTag, "LegacyDbConfigConnectTempRoleError");
  const loginReport = formatSanitizedReport(loginRole);
  assert.match(loginReport, /category: login_role_failure/);
  assert.doesNotMatch(loginReport, /migration_sql_error/);
  assert.doesNotMatch(loginReport, /alter role/);
});

test("stage advances to the furthest observed banner", () => {
  const classified = classifyHostedCliOutput({
    status: 0,
    stdout:
      "Initialising login role...\nConnecting to remote database...\nWould apply the following migrations:\n  - 0002_identity_tenancy.sql\n  - 0003_owner_provisioning.sql\n",
    stderr: "",
  });
  assert.equal(classified.ok, true);
  assert.equal(classified.stage, "listing_pending");
  assert.equal(classified.migration, null);
  const report = formatSanitizedReport(classified);
  assert.match(report, /^stage: listing_pending$/m);
  assert.doesNotMatch(report, /^migration:/m);
  assert.doesNotMatch(report, /^cli_tag:/m);
});

function assertNoCredentialEcho(report, extra = []) {
  for (const forbidden of [PASSWORD, LINKED_REF, HOST, "aws-0-", "postgres://", "--db-url", "user=", ...extra]) {
    assert.ok(!report.includes(forbidden), `report leaked ${forbidden.length} chars of sensitive text`);
  }
}

test("static encoding analysis flags passwords the Go CLI rejects but Node accepts", () => {
  const ok = analyzeMigrationUrlEncoding(sessionUrl());
  assert.deepEqual(ok, {
    passwordPresent: true,
    passwordPercentEncoded: false,
    nodeDecodes: true,
    cliCompatible: true,
    issues: [],
  });
  const encoded = analyzeMigrationUrlEncoding(sessionUrl({ password: ENCODED_SPECIAL }));
  assert.equal(encoded.cliCompatible, true);
  assert.equal(encoded.passwordPercentEncoded, true);

  const cases = [
    ["pa^ss|wo{rd}", "unencoded_unsafe_chars"],
    ["pa ss", "whitespace_or_control"],
    ["pa%zzss", "invalid_percent_escape"],
    ["pässwörd", "non_ascii"],
    ["pa`ss", "quote_chars"],
    ["pa[ss]", "unencoded_unsafe_chars"],
  ];
  for (const [password, issue] of cases) {
    const url = sessionUrl({ password });
    assert.doesNotThrow(() => new URL(url), "Node accepts the URL");
    const analysis = analyzeMigrationUrlEncoding(url);
    assert.equal(analysis.cliCompatible, false, issue);
    assert.ok(analysis.issues.includes(issue), `${issue} in ${analysis.issues.join(",")}`);
  }
  const rawAt = analyzeMigrationUrlEncoding(sessionUrl({ password: "p@ssword-ok" }));
  assert.ok(rawAt.issues.includes("raw_at_sign"));
  assert.equal(rawAt.cliCompatible, true);
});

test("maps pgx and Supavisor connect errors to specific categories and signals", () => {
  const user = `postgres.${LINKED_REF}`;
  const prefix = `failed to connect to postgres: failed to connect to \`user=${user} database=postgres\`: 1.2.3.4:5432 (${HOST}):`;
  const cases = [
    [`${prefix} server error: FATAL: Tenant or user not found (SQLSTATE XX000)`, "tenant_not_found", "tenant_or_user_not_found", "XX000"],
    [`${prefix} failed SASL auth: FATAL: password authentication failed for user "${user}" (SQLSTATE 28P01)`, "authentication_failed", "password_rejected", "28P01"],
    [`${prefix} server error: FATAL: Circuit breaker open: Too many authentication errors (SQLSTATE XX000)`, "pooler_circuit_breaker", "circuit_breaker", "XX000"],
    [`${prefix} server error: FATAL: Max client connections reached (SQLSTATE XX000)`, "pooler_capacity", "pooler_capacity", "XX000"],
    [`failed to connect to postgres: hostname resolving error: lookup ${HOST}: no such host`, "dns_failure", "hostname_resolve", null],
    [`${prefix} dial error: dial tcp 1.2.3.4:5432: i/o timeout`, "connection_timeout", "timeout", null],
    [`${prefix} dial error: dial tcp 1.2.3.4:5432: connectex: No connection could be made because the target machine actively refused it.`, "connection_refused", "connection_refused", null],
    [`${prefix} tls error: remote error: tls: handshake failure`, "tls_failure", "tls", null],
    [`${prefix} failed to receive message: unexpected EOF`, "connection_reset", "connection_reset", null],
    [`failed to connect to postgres: cannot parse \`postgresql://${user}:xxxxx@${HOST}:5432/postgres\`: failed to parse as URL (parse "postgresql://${user}:xxxxx@${HOST}:5432/postgres": net/url: invalid userinfo)`, "url_parse_failure", "url_parse", null],
    ["Remote migration versions not found in local migrations directory.\nMake sure your local git repo is up-to-date. If the error persists, try repairing the migration history table:\nsupabase migration repair --status reverted 0030", "migration_history_mismatch", "remote_history_not_local", null],
    ["Found local migration files to be inserted before the last migration on remote database.", "migration_history_mismatch", "local_before_remote", null],
  ];
  for (const [stderr, category, signal, code] of cases) {
    const classified = classifyHostedCliOutput({ status: 1, stdout: "Connecting to remote database...\n", stderr });
    assert.equal(classified.category, category, stderr.slice(0, 60));
    assert.ok(classified.signals.includes(signal), `${signal} in ${classified.signals.join(",")}`);
    assert.equal(classified.code, code);
    const report = formatSanitizedReport(classified);
    assert.match(report, new RegExp(`^category: ${category}$`, "m"));
    assert.match(report, /^cli_signals: [a-z_,]+$/m);
    assert.match(report, /^hint: /m);
    assertNoCredentialEcho(report, ["1.2.3.4", "Tenant", "FATAL", "xxxxx"]);
  }
  assert.deepEqual(detectCliSignals("Would push these migrations:\n • 0029_change_order_pdf.sql"), []);
  const listed = classifyHostedCliOutput({
    status: 0,
    stdout: "Connecting to remote database...\nWould push these migrations:\n • 0029_change_order_pdf.sql\n",
  });
  assert.equal(listed.connectionSucceeded, true);
  assert.equal(listed.stage, "listing_pending");
  assert.deepEqual(listed.pending, ["0029_change_order_pdf.sql"]);
});

test("unmatched CLI text stays unknown with a signal-free report and a generic hint", () => {
  const classified = classifyHostedCliOutput({ status: 1, stdout: "Connecting to remote database...\n", stderr: "zzz opaque" });
  const report = formatSanitizedReport(classified);
  assert.match(report, /^category: unknown_failure$/m);
  assert.match(report, /^cli_signals: \(none\)$/m);
  assert.match(report, /^cli_output: present$/m);
  assert.doesNotMatch(report, /zzz/);
});

test("live push refuses a CLI-incompatible password without spawning; check still spawns once", async () => {
  const url = sessionUrl({ password: "pa^ss|word-long" });
  const live = captureWriters();
  let spawned = 0;
  const liveStatus = await applyHostedMigrations({
    env: { DATABASE_URL_MIGRATIONS: url },
    projectRefPath: writeRefFile(LINKED_REF),
    platform: "linux",
    spawn: () => {
      spawned += 1;
      return { status: 0, stdout: "", stderr: "" };
    },
    stdout: live.stdout,
    stderr: live.stderr,
  });
  assert.equal(liveStatus, 1);
  assert.equal(spawned, 0);
  assert.match(live.stdoutText(), /^stage: preflight$/m);
  assert.match(live.stdoutText(), /^category: url_encoding_failure$/m);
  assert.match(live.stdoutText(), /^password_cli_compatible: false$/m);
  assert.match(live.stdoutText(), /^password_issues: unencoded_unsafe_chars$/m);
  assertNoCredentialEcho(live.stdoutText(), ["pa^ss", "word-long"]);

  const check = captureWriters();
  const checkStatus = await applyHostedMigrations({
    env: { DATABASE_URL_MIGRATIONS: url },
    projectRefPath: writeRefFile(LINKED_REF),
    platform: "linux",
    dryRun: true,
    spawn: (_bin, argv) => {
      spawned += 1;
      assert.deepEqual(argv, expectedHostedArgv(url, { dryRun: true }));
      return { status: 1, stdout: "Connecting to remote database...\n", stderr: "unrecognised" };
    },
    stdout: check.stdout,
    stderr: check.stderr,
  });
  assert.equal(checkStatus, 1);
  assert.equal(spawned, 1);
  assert.match(check.stdoutText(), /^category: url_encoding_failure$/m);
  assertNoCredentialEcho(check.stdoutText(), ["pa^ss", "word-long"]);
});

test("does not spawn debug or machine-readable CLI flags", () => {
  const url = sessionUrl();
  const jsEntry = writeJsEntry();
  for (const dryRun of [false, true]) {
    const linux = hostedCliLaunch(url, { platform: "linux", dryRun });
    const windows = hostedCliLaunch(url, {
      platform: "win32",
      execPath: process.execPath,
      requireResolve: () => jsEntry,
      dryRun,
    });
    assertNoExtraCliFlags(linux.argv);
    assertNoExtraCliFlags(windows.argv);
    assert.equal(linux.argv.filter((part) => part === "--yes").length, dryRun ? 0 : 1);
    assert.equal(windows.argv.filter((part) => part === "--yes").length, dryRun ? 0 : 1);
    assert.equal(linux.argv.includes("--dry-run"), dryRun);
    assert.equal(windows.argv.includes("--dry-run"), dryRun);
    assert.equal(linux.spawnOptions.shell, false);
    assert.equal(windows.spawnOptions.shell, false);
  }
});
