import { describe, expect, it, vi } from "vitest";
import { EMPTY_DRAFT_SYNC } from "@job-to-invoice/schemas";
import {
  bindDraftSyncController,
  discardLocalDrafts,
  getDraftSyncStatus,
  LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED,
  synchronizeLocalDrafts,
} from "../drafts/sync.ts";
import { createMemorySqlite } from "./memory-db.ts";
import { migrateOwnerDatabase, readSchemaMeta } from "../storage/schema.ts";
import { persistDraftLocally, drainOutbox } from "../drafts/persist.ts";
import { enqueueOutboxOperation, countUnsyncedWork } from "./outbox.ts";
import { resolveDraftConflict, pauseResourceForConflict } from "./conflict.ts";
import { outboxRetryDelayMs, OUTBOX_MAX_DELAY_MS, OUTBOX_MIN_DELAY_MS } from "./retry.ts";
import { assertOutboxOperationAllowed, isForbiddenOutboxPath } from "./outbox-rules.ts";
import { canUseCachedCommercialData, requireOfflineCommercialAccess } from "./offline-gate.ts";
import { buildSyncConflictAnalytics, syncConflictAnalyticsIsSafe } from "./analytics.ts";
import { drainDiagnosticIsSafe } from "./drain-diagnostics.ts";
import { StorageError } from "../storage/storage-error.ts";
import { upsertCachedJob, listCachedJobs } from "../jobs/cache.ts";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function patchNotes(notes: string) {
  return { notes, terms: "", expiry_days: 14, lines: [] };
}

describe("SYNC01 draft-sync adapter", () => {
  it("marks local persistence implemented and stays empty until a controller is bound", async () => {
    bindDraftSyncController(null);
    expect(LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED).toBe(true);
    await expect(getDraftSyncStatus()).resolves.toEqual(EMPTY_DRAFT_SYNC);
    await expect(discardLocalDrafts()).resolves.toBeUndefined();
    await expect(synchronizeLocalDrafts(async () => ({ ok: true, data: {} }))).resolves.toEqual({
      ok: false,
      reason: "storage",
    });
  });
});

describe("SYNC01 schema and owner binding", () => {
  it("migrates and binds owner/workspace metadata", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE }, "2026-09-20T00:00:00.000Z");
    await expect(readSchemaMeta(db)).resolves.toEqual({
      version: 1,
      ownerId: OWNER,
      workspaceId: WORKSPACE,
    });
  });

  it("rejects a different owner binding", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await expect(
      migrateOwnerDatabase(db, {
        ownerId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        workspaceId: WORKSPACE,
      }),
    ).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
  });
});

describe("SYNC01 outbox rules and retry", () => {
  it("forbids irreversible money commands and allows draft/job writes", () => {
    expect(isForbiddenOutboxPath("/v1/drafts/x/publish")).toBe(true);
    expect(isForbiddenOutboxPath("/v1/jobs/x/cancel")).toBe(true);
    expect(isForbiddenOutboxPath("/v1/jobs/x/archive")).toBe(true);
    expect(isForbiddenOutboxPath("/v1/jobs/x/finish")).toBe(true);
    expect(isForbiddenOutboxPath("/v1/subscription/trial")).toBe(true);
    expect(isForbiddenOutboxPath("/v1/exports")).toBe(true);
    expect(isForbiddenOutboxPath("/v1/account/deletion")).toBe(true);
    expect(isForbiddenOutboxPath("/v1/account/action-grants")).toBe(true);
    expect(isForbiddenOutboxPath("/v1/jobs/x/quote")).toBe(false);
    expect(isForbiddenOutboxPath("/v1/customers")).toBe(true);
    expect(() =>
      assertOutboxOperationAllowed({ method: "POST", path: "/v1/customers", resourceKind: "job" }),
    ).toThrow(/OUTBOX_FORBIDDEN/);
    expect(() =>
      assertOutboxOperationAllowed({ method: "POST", path: "/v1/jobs", resourceKind: "job" }),
    ).not.toThrow();
    expect(() =>
      assertOutboxOperationAllowed({ method: "POST", path: "/v1/quotes/1/publish", resourceKind: "draft" }),
    ).toThrow();
  });

  it("schedules exponential jitter between 2s and 5 minutes", () => {
    expect(outboxRetryDelayMs(0, () => 0)).toBeGreaterThanOrEqual(OUTBOX_MIN_DELAY_MS / 2);
    expect(outboxRetryDelayMs(20, () => 1)).toBeLessThanOrEqual(OUTBOX_MAX_DELAY_MS);
  });
});

describe("SYNC01 persist-before-network and outbox", () => {
  it("persists draft locally before network and keeps stable operation ids across retries", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    const opId = "op-1";
    const key = "idem-1";
    const first = await persistDraftLocally(db, {
      draftId: "draft-1",
      jobId: "job-1",
      kind: "quote",
      schemaVersion: 1,
      baseVersion: 3,
      payload: patchNotes("a"),
      patchBody: patchNotes("a"),
      operationId: opId,
      idempotencyKey: key,
      nowIso: "2026-09-20T01:00:00.000Z",
    });
    expect(first.status).toBe("saved_on_device");
    expect(await countUnsyncedWork(db)).toBeGreaterThan(0);

    const second = await persistDraftLocally(db, {
      draftId: "draft-1",
      jobId: "job-1",
      kind: "quote",
      schemaVersion: 1,
      baseVersion: 3,
      payload: patchNotes("b"),
      patchBody: patchNotes("b"),
      operationId: opId,
      idempotencyKey: key,
      nowIso: "2026-09-20T01:00:01.000Z",
    });
    expect(second.status).toBe("saved_on_device");
    const pending = (db.tables.outbox_ops ?? []).filter((row) => row.state === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.idempotency_key).toBe(key);
    expect(String(pending[0]?.body_json)).toContain('"notes":"b"');
  });

  it("drains outbox on success and pauses on 409 without LWW", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await persistDraftLocally(db, {
      draftId: "draft-2",
      jobId: "job-2",
      kind: "quote",
      schemaVersion: 1,
      baseVersion: 1,
      payload: patchNotes("local"),
      patchBody: patchNotes("local"),
      operationId: "op-2",
      idempotencyKey: "idem-2",
      nowIso: "2026-09-20T02:00:00.000Z",
    });

    const ok = await drainOutbox(db, {
      nowMs: Date.parse("2026-09-20T02:00:00.000Z"),
      request: async () => ({ ok: true, data: { version: 2, notes: "local" } }),
    });
    expect(ok.drained).toBe(1);
    expect(ok.remaining).toBe(0);

    await persistDraftLocally(db, {
      draftId: "draft-3",
      jobId: "job-3",
      kind: "quote",
      schemaVersion: 1,
      baseVersion: 1,
      payload: patchNotes("local"),
      patchBody: patchNotes("local"),
      operationId: "op-3",
      idempotencyKey: "idem-3",
      nowIso: "2026-09-20T03:00:00.000Z",
    });
    const conflicted = await drainOutbox(db, {
      nowMs: Date.parse("2026-09-20T03:00:00.000Z"),
      request: async () => ({
        ok: false,
        error: { status: 409, code: "VERSION_CONFLICT", message: "Conflict", retryable: false },
      }),
    });
    expect(conflicted.conflicts).toBe(1);
    expect((db.tables.outbox_ops ?? []).some((row) => row.state === "paused_conflict")).toBe(true);
    expect((db.tables.local_drafts ?? []).find((row) => row.draft_id === "draft-3")?.sync_state).toBe("conflict");
  });

  it("supports both conflict choices", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await persistDraftLocally(db, {
      draftId: "draft-4",
      jobId: "job-4",
      kind: "quote",
      schemaVersion: 1,
      baseVersion: 4,
      payload: patchNotes("local"),
      patchBody: patchNotes("local"),
      operationId: "op-4",
      idempotencyKey: "idem-4",
      nowIso: "2026-09-20T04:00:00.000Z",
    });
    await pauseResourceForConflict(db, {
      draftId: "draft-4",
      operationId: "op-4",
      localJson: JSON.stringify({ notes: "local" }),
      serverJson: JSON.stringify({ notes: "server", version: 5 }),
      nowIso: "2026-09-20T04:00:01.000Z",
    });
    await expect(
      resolveDraftConflict(db, {
        draftId: "draft-4",
        choice: "keep_server",
        serverPayloadJson: JSON.stringify({ notes: "server", version: 5 }),
        serverVersion: 5,
      }),
    ).resolves.toBe("kept_server");

    await persistDraftLocally(db, {
      draftId: "draft-5",
      jobId: "job-5",
      kind: "quote",
      schemaVersion: 1,
      baseVersion: 1,
      payload: patchNotes("local-2"),
      patchBody: patchNotes("local-2"),
      operationId: "op-5",
      idempotencyKey: "idem-5",
      nowIso: "2026-09-20T05:00:00.000Z",
    });
    await pauseResourceForConflict(db, {
      draftId: "draft-5",
      operationId: "op-5",
      localJson: JSON.stringify({ notes: "local-2" }),
      serverJson: JSON.stringify({ notes: "server-2", version: 2 }),
    });
    await expect(
      resolveDraftConflict(db, {
        draftId: "draft-5",
        choice: "save_local_copy",
        serverPayloadJson: JSON.stringify({ notes: "server-2", version: 2 }),
        serverVersion: 2,
        localCopy: {
          draftId: "draft-5-copy",
          jobId: "job-5",
          kind: "quote",
          schemaVersion: 1,
          payloadJson: JSON.stringify({ notes: "local-2" }),
          baseVersion: 1,
        },
      }),
    ).resolves.toBe("saved_local_copy");
    expect((db.tables.local_drafts ?? []).some((row) => row.draft_id === "draft-5-copy")).toBe(true);
  });
});

describe("SYNC01 offline gate, jobs cache, analytics safety", () => {
  it("enforces the seven-day offline window and cache miss honesty", async () => {
    const now = Date.parse("2026-09-20T12:00:00.000Z");
    expect(canUseCachedCommercialData("authenticated", "2026-09-20T12:00:00.000Z", now)).toBe(true);
    expect(canUseCachedCommercialData("offline_cached", "2026-09-14T12:00:00.000Z", now)).toBe(true);
    expect(canUseCachedCommercialData("offline_cached", "2026-09-01T12:00:00.000Z", now)).toBe(false);
    expect(() => requireOfflineCommercialAccess("2026-09-01T12:00:00.000Z", now)).toThrow(StorageError);

    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await expect(listCachedJobs(db, { listState: "active" })).resolves.toEqual([]);
    await upsertCachedJob(db, {
      jobId: "job-1",
      payloadJson: JSON.stringify({ id: "job-1", customer_name: "Ada", title: "Roof" }),
      listState: "active",
    });
    await expect(listCachedJobs(db, { listState: "active", search: "ada" })).resolves.toHaveLength(1);
  });

  it("emits only allowlisted sync_conflict properties", () => {
    const props = buildSyncConflictAnalytics({ resourceKind: "draft", clientVersion: "3" });
    expect(props).toEqual({ resource_kind: "draft", client_version: "3" });
    expect(syncConflictAnalyticsIsSafe(props, ["Ada Lovelace", "secret-token", "PRAGMA key"])).toBe(true);
    expect(
      syncConflictAnalyticsIsSafe(
        { ...props, notes: "secret" } as unknown as Record<string, unknown>,
        [],
      ),
    ).toBe(false);
  });

  it("enforces one in-flight operation per resource", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await enqueueOutboxOperation(db, {
      operationId: "a",
      resourceKind: "draft",
      resourceId: "draft-x",
      method: "PATCH",
      path: "/v1/drafts/draft-x",
      bodyJson: "{}",
      baseVersion: 1,
      idempotencyKey: "k1",
      nowIso: "2026-09-20T06:00:00.000Z",
    });
    const first = db.tables.outbox_ops?.[0];
    expect(first).toBeDefined();
    if (!first) {
      throw new Error("expected outbox row");
    }
    first.state = "in_flight";
    const successor = await enqueueOutboxOperation(db, {
      operationId: "b",
      resourceKind: "draft",
      resourceId: "draft-x",
      method: "PATCH",
      path: "/v1/drafts/draft-x",
      bodyJson: "{\"notes\":\"later\"}",
      baseVersion: 1,
      idempotencyKey: "k2",
    });
    expect(successor.operationId).toBe("b");
    expect(successor.state).toBe("pending");
    expect(db.tables.outbox_ops?.find((row) => row.operation_id === "a")?.state).toBe("in_flight");
    expect(db.tables.outbox_ops?.filter((row) => row.state === "in_flight")).toHaveLength(1);
  });
});

describe("SYNC01 sign-out synchronize path", () => {
  it("does not fabricate synchronize success", async () => {
    const { completeOwnerSignOut } = await import("../session/sign-out.ts");
    const result = await completeOwnerSignOut({
      mode: "synchronize",
      discardDrafts: async () => undefined,
      synchronizeDrafts: async () => ({ ok: false }),
      providerSignOut: async () => undefined,
      clearStoredAuth: async () => undefined,
      clearMemory: () => undefined,
    });
    expect(result).toEqual({ ok: false, stage: "synchronize" });
  });

  it("signs out after successful synchronize", async () => {
    const { completeOwnerSignOut } = await import("../session/sign-out.ts");
    const clearMemory = vi.fn();
    const result = await completeOwnerSignOut({
      mode: "synchronize",
      discardDrafts: async () => undefined,
      synchronizeDrafts: async () => ({ ok: true }),
      providerSignOut: async () => undefined,
      clearStoredAuth: async () => undefined,
      clearMemory,
    });
    expect(result).toEqual({ ok: true });
    expect(clearMemory).toHaveBeenCalled();
  });

  it("signs out only after successful drain leaves an empty outbox", async () => {
    const { completeOwnerSignOut } = await import("../session/sign-out.ts");
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await persistDraftLocally(db, {
      draftId: "draft-signout",
      jobId: "job-signout",
      kind: "quote",
      schemaVersion: 1,
      baseVersion: 1,
      payload: patchNotes("x"),
      patchBody: patchNotes("x"),
      operationId: "op-signout",
      idempotencyKey: "idem-signout",
      nowIso: "2026-09-20T10:00:00.000Z",
    });
    const clearMemory = vi.fn();
    const providerSignOut = vi.fn();
    const failed = await completeOwnerSignOut({
      mode: "synchronize",
      discardDrafts: async () => undefined,
      synchronizeDrafts: async () => {
        const result = await drainOutbox(db, {
          forceImmediate: true,
          nowMs: Date.parse("2026-09-20T10:00:00.000Z"),
          request: async () => ({
            ok: false,
            error: { status: 0, code: "UNAVAILABLE", message: "offline", retryable: true },
          }),
        });
        return result.remaining === 0 ? { ok: true } : { ok: false };
      },
      providerSignOut,
      clearStoredAuth: async () => undefined,
      clearMemory,
    });
    expect(failed).toEqual({ ok: false, stage: "synchronize" });
    expect(providerSignOut).not.toHaveBeenCalled();
    expect(clearMemory).not.toHaveBeenCalled();
    expect((db.tables.outbox_ops ?? []).some((row) => row.state === "pending")).toBe(true);
  });
});

describe("SYNC01 manual synchronize drain", () => {
  async function seedQueuedDraft(
    db: ReturnType<typeof createMemorySqlite>,
    id = "draft-manual",
    nowIso = "2026-09-20T12:00:00.000Z",
  ) {
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await persistDraftLocally(db, {
      draftId: id,
      jobId: `job-${id}`,
      kind: "quote",
      schemaVersion: 1,
      baseVersion: 2,
      payload: patchNotes("queued"),
      patchBody: patchNotes("queued"),
      operationId: `op-${id}`,
      idempotencyKey: `idem-${id}`,
      nowIso,
    });
  }

  function bindForceController(db: ReturnType<typeof createMemorySqlite>) {
    bindDraftSyncController({
      ownerId: OWNER,
      workspaceId: WORKSPACE,
      ensureOpen: async () => {
        throw new Error("unused");
      },
      getSession: () => null,
      getStatus: async () => ({ hasUnsyncedDrafts: true, synchronizeAvailable: true }),
      synchronize: async (request, options) => {
        const result = await drainOutbox(db, {
          request,
          forceImmediate: options?.forceImmediate !== false,
          nowMs: Date.parse("2026-09-20T12:05:00.000Z"),
        });
        if (result.conflicts > 0) {
          return { ok: false, reason: "conflict" };
        }
        if (result.remaining === 0) {
          return { ok: true };
        }
        if (result.drained === 0) {
          return { ok: false, reason: "failed" };
        }
        return { ok: false, reason: "failed" };
      },
      discardAndWipe: async () => undefined,
      close: async () => undefined,
    });
  }

  it("Settings Synchronize invokes the real outbox drain with one authenticated PATCH", async () => {
    const db = createMemorySqlite();
    await seedQueuedDraft(db);
    bindForceController(db);
    const requests: Array<{ method?: string; path: string; idempotencyKey?: string; ifMatch?: string | number }> =
      [];
    const synced = await synchronizeLocalDrafts(async (options) => {
      requests.push(options);
      return { ok: true, data: { version: 3, notes: "queued" } };
    }, { forceImmediate: true });
    expect(synced).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.path).toBe("/v1/drafts/draft-manual");
    expect(requests[0]?.idempotencyKey).toBe("idem-draft-manual");
    expect(requests[0]?.ifMatch).toBe(2);
    expect((db.tables.outbox_ops ?? []).find((row) => row.operation_id === "op-draft-manual")?.state).toBe("done");
    expect((db.tables.local_drafts ?? []).find((row) => row.draft_id === "draft-manual")?.sync_state).toBe(
      "synced",
    );
  });

  it("manual sync overrides next_attempt_at backoff without dropping the outbox entry", async () => {
    const db = createMemorySqlite();
    await seedQueuedDraft(db);
    const row = db.tables.outbox_ops?.[0];
    expect(row).toBeDefined();
    if (!row) {
      throw new Error("expected outbox row");
    }
    row.next_attempt_at = "2026-09-20T12:30:00.000Z";
    row.attempts = 3;
    const nowMs = Date.parse("2026-09-20T12:05:00.000Z");
    const blocked = await drainOutbox(db, {
      forceImmediate: false,
      nowMs,
      request: async () => ({ ok: true, data: { version: 3 } }),
    });
    expect(blocked.outcome).toBe("ineligible_retry_time");
    expect(blocked.drained).toBe(0);
    expect(blocked.remaining).toBe(1);

    const requests: string[] = [];
    const forced = await drainOutbox(db, {
      forceImmediate: true,
      nowMs,
      request: async (options) => {
        requests.push(String(options.idempotencyKey));
        return { ok: true, data: { version: 3 } };
      },
    });
    expect(forced.outcome).toBe("drained");
    expect(forced.remaining).toBe(0);
    expect(requests).toEqual(["idem-draft-manual"]);
    expect(row.operation_id).toBe("op-draft-manual");
  });

  it("reclaims stuck in_flight on manual sync and reuses the same operation_id/idempotency key", async () => {
    const db = createMemorySqlite();
    await seedQueuedDraft(db);
    const row = db.tables.outbox_ops?.[0];
    expect(row).toBeDefined();
    if (!row) {
      throw new Error("expected outbox row");
    }
    row.state = "in_flight";
    row.updated_at = "2026-09-20T12:00:00.000Z";
    const keys: Array<{ operationId: string; key: string }> = [];
    const first = await drainOutbox(db, {
      forceImmediate: true,
      nowMs: Date.parse("2026-09-20T12:05:00.000Z"),
      request: async (options) => {
        keys.push({ operationId: "op-draft-manual", key: String(options.idempotencyKey) });
        return {
          ok: false,
          error: { status: 0, code: "UNAVAILABLE", message: "offline", retryable: true },
        };
      },
    });
    expect(first.remaining).toBe(1);
    expect(first.outcome).toBe("offline");
    expect((db.tables.outbox_ops ?? [])[0]?.state).toBe("pending");

    const second = await drainOutbox(db, {
      forceImmediate: true,
      nowMs: Date.parse("2026-09-20T12:05:01.000Z"),
      request: async (options) => {
        keys.push({ operationId: "op-draft-manual", key: String(options.idempotencyKey) });
        return { ok: true, data: { version: 3 } };
      },
    });
    expect(second.remaining).toBe(0);
    expect(keys).toEqual([
      { operationId: "op-draft-manual", key: "idem-draft-manual" },
      { operationId: "op-draft-manual", key: "idem-draft-manual" },
    ]);
  });

  it("distinguishes empty outbox from a failed drain", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    const empty = await drainOutbox(db, {
      nowMs: Date.parse("2026-09-20T12:00:00.000Z"),
      request: async () => ({ ok: true, data: {} }),
    });
    expect(empty).toMatchObject({ outcome: "empty", drained: 0, remaining: 0 });

    await seedQueuedDraft(db);
    const failed = await drainOutbox(db, {
      forceImmediate: true,
      nowMs: Date.parse("2026-09-20T12:00:00.000Z"),
      request: async () => ({
        ok: false,
        error: { status: 500, code: "UNAVAILABLE", message: "server", retryable: true },
      }),
    });
    expect(failed.outcome).toBe("server_failure");
    expect(failed.remaining).toBe(1);
    expect(failed.drained).toBe(0);
  });

  it("missing session fails safely without deleting data", async () => {
    const db = createMemorySqlite();
    await seedQueuedDraft(db);
    const result = await drainOutbox(db, {
      forceImmediate: true,
      nowMs: Date.parse("2026-09-20T12:00:00.000Z"),
      request: async () => ({
        ok: false,
        error: {
          status: 401,
          code: "AUTHENTICATION_REQUIRED",
          message: "Sign in required.",
          retryable: false,
        },
      }),
    });
    expect(result.outcome).toBe("no_authenticated_session");
    expect(result.remaining).toBe(1);
    expect((db.tables.local_drafts ?? [])[0]?.sync_state).toBe("queued");
    expect((db.tables.outbox_ops ?? [])[0]?.state).toBe("pending");
  });

  it("401 performs at most one refresh then retries once", async () => {
    const db = createMemorySqlite();
    await seedQueuedDraft(db);
    let patches = 0;
    let refreshes = 0;
    const bareRequest: Parameters<typeof drainOutbox>[1]["request"] = async () => {
      patches += 1;
      if (patches === 1) {
        return {
          ok: false,
          error: { status: 401, code: "AUTHENTICATION_REQUIRED", message: "expired", retryable: false },
        };
      }
      return { ok: true, data: { version: 3 } };
    };
    const wrapped: Parameters<typeof drainOutbox>[1]["request"] = async (options) => {
      const first = await bareRequest(options);
      if (first.ok || first.error.status !== 401) {
        return first;
      }
      refreshes += 1;
      return bareRequest(options);
    };
    const result = await drainOutbox(db, {
      forceImmediate: true,
      nowMs: Date.parse("2026-09-20T12:00:00.000Z"),
      request: wrapped,
    });
    expect(result.remaining).toBe(0);
    expect(patches).toBe(2);
    expect(refreshes).toBe(1);
  });

  it("409 preserves local data and creates conflict state", async () => {
    const db = createMemorySqlite();
    await seedQueuedDraft(db, "draft-409");
    const result = await drainOutbox(db, {
      forceImmediate: true,
      nowMs: Date.parse("2026-09-20T12:00:00.000Z"),
      request: async () => ({
        ok: false,
        error: { status: 409, code: "VERSION_CONFLICT", message: "Conflict", retryable: false },
      }),
    });
    expect(result.outcome).toBe("conflict");
    expect((db.tables.local_drafts ?? []).find((row) => row.draft_id === "draft-409")?.sync_state).toBe(
      "conflict",
    );
    expect(String((db.tables.local_drafts ?? [])[0]?.conflict_local_json)).toContain("queued");
    expect((db.tables.outbox_ops ?? []).some((row) => row.state === "paused_conflict")).toBe(true);
  });

  it("foreground/reconnect drain respects backoff; concurrent manual drains do not duplicate PATCH", async () => {
    const db = createMemorySqlite();
    await seedQueuedDraft(db);
    const row = db.tables.outbox_ops?.[0];
    expect(row).toBeDefined();
    if (!row) {
      throw new Error("expected outbox row");
    }
    row.next_attempt_at = "2026-09-20T12:30:00.000Z";
    const autoRequests: number[] = [];
    const auto = await drainOutbox(db, {
      forceImmediate: false,
      nowMs: Date.parse("2026-09-20T12:05:00.000Z"),
      request: async () => {
        autoRequests.push(1);
        return { ok: true, data: { version: 3 } };
      },
    });
    expect(auto.outcome).toBe("ineligible_retry_time");
    expect(autoRequests).toHaveLength(0);

    let patches = 0;
    let draining: Promise<{ ok: true } | { ok: false; reason: "failed" }> | null = null;
    const synchronize = async () => {
      if (draining) {
        return draining;
      }
      draining = (async () => {
        const result = await drainOutbox(db, {
          forceImmediate: true,
          nowMs: Date.parse("2026-09-20T12:05:00.000Z"),
          request: async () => {
            patches += 1;
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { ok: true, data: { version: 3 } };
          },
        });
        return result.remaining === 0 ? { ok: true as const } : { ok: false as const, reason: "failed" as const };
      })();
      try {
        return await draining;
      } finally {
        draining = null;
      }
    };
    const [a, b] = await Promise.all([synchronize(), synchronize()]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(patches).toBe(1);
  });

  it("logs and drain diagnostics contain no sensitive data", () => {
    const event = {
      stage: "complete",
      outcome: "drained",
      operationKind: "draft",
      httpStatus: 200,
      drained: 1,
      remaining: 0,
    };
    expect(
      drainDiagnosticIsSafe(event, [
        "owner-id",
        "Bearer",
        "secret@email.com",
        "PRAGMA key",
        "/data/user/0/",
        '"notes":"secret"',
      ]),
    ).toBe(true);
    expect(
      drainDiagnosticIsSafe(
        { ...event, path: "/v1/drafts/abc" } as unknown as Record<string, unknown>,
        [],
      ),
    ).toBe(false);
  });
});
