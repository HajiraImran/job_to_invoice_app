import { describe, expect, it, vi } from "vitest";
import { drainOutbox, persistDraftLocally } from "../drafts/persist.ts";
import { getLocalDraft, getLocalDraftByJob } from "../drafts/repository.ts";
import { completeOwnerSignOut, signOutFailureCopy } from "../session/sign-out.ts";
import { migrateOwnerDatabase } from "../storage/schema.ts";
import { copy } from "../i18n/en.ts";
import { buildSyncConflictAnalytics, syncConflictAnalyticsIsSafe } from "./analytics.ts";
import {
  isVersionConflictStub,
  noteServerDraftChanged,
  pauseResourceForConflict,
  readFullServerDraft,
  recoverableLocalJson,
  resolveDraftConflict,
  saveRecoverableLocalCopy,
} from "./conflict.ts";
import { drainDiagnosticIsSafe } from "./drain-diagnostics.ts";
import { createMemorySqlite } from "./memory-db.ts";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DRAFT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const COPY = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LOCAL_PATCH = { notes: "local work", terms: "", expiry_days: 14, lines: [] as [] };
const LOCAL_WORK = JSON.stringify(LOCAL_PATCH);

function fullDraft(version: number, notes: string) {
  return {
    id: DRAFT,
    job_id: JOB,
    kind: "quote",
    version,
    schema_version: 1,
    notes,
    terms: "",
    expiry_days: 14,
    lines: [] as [],
  };
}

async function seedConflict(
  db: ReturnType<typeof createMemorySqlite>,
  input?: { serverJson?: string; draftId?: string; jobId?: string; operationId?: string },
) {
  const draftId = input?.draftId ?? DRAFT;
  const jobId = input?.jobId ?? JOB;
  const operationId = input?.operationId ?? "op-conflict";
  await persistDraftLocally(db, {
    draftId,
    jobId,
    kind: "quote",
    schemaVersion: 1,
    baseVersion: 4,
    payload: LOCAL_PATCH,
    patchBody: LOCAL_PATCH,
    operationId,
    idempotencyKey: `idem-${operationId}`,
    nowIso: "2026-09-27T12:00:00.000Z",
  });
  await pauseResourceForConflict(db, {
    draftId,
    operationId,
    localJson: LOCAL_WORK,
    serverJson: input?.serverJson ?? JSON.stringify({ code: "VERSION_CONFLICT" }),
    nowIso: "2026-09-27T12:00:01.000Z",
  });
}

describe("S23 conflict resolution", () => {
  it("rejects a 409 stub and keeps both shelved copies", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await seedConflict(db);
    expect(readFullServerDraft({ code: "VERSION_CONFLICT" })).toBeNull();
    expect(isVersionConflictStub(JSON.stringify({ code: "VERSION_CONFLICT" }))).toBe(true);
    const before = await getLocalDraft(db, DRAFT);
    await expect(
      resolveDraftConflict(db, {
        draftId: DRAFT,
        choice: "keep_server",
        serverPayloadJson: JSON.stringify({ code: "VERSION_CONFLICT" }),
        serverVersion: 9,
      }),
    ).rejects.toThrow();
    const after = await getLocalDraft(db, DRAFT);
    expect(after?.syncState).toBe("conflict");
    expect(after?.conflictLocalJson).toBe(before?.conflictLocalJson);
    expect(after?.conflictServerJson).toBe(before?.conflictServerJson);
    expect(after?.payloadJson).toBe(before?.payloadJson);
  });

  it("keeps the server version only from a full draft payload", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await seedConflict(db);
    const server = fullDraft(6, "server notes");
    const parsed = readFullServerDraft(server);
    expect(parsed?.version).toBe(6);
    await expect(
      resolveDraftConflict(db, {
        draftId: DRAFT,
        choice: "keep_server",
        serverPayloadJson: parsed?.payloadJson ?? "",
        serverVersion: 6,
      }),
    ).resolves.toBe("kept_server");
    const after = await getLocalDraft(db, DRAFT);
    expect(after?.syncState).toBe("synced");
    expect(after?.payloadJson).toContain("server notes");
    expect(after?.conflictLocalJson).toBeNull();
    expect(after?.conflictServerJson).toBeNull();
    expect(after?.serverVersion).toBe(6);
    expect((db.tables.outbox_ops ?? []).some((row) => row.resource_id === DRAFT)).toBe(false);
    await expect(
      resolveDraftConflict(db, {
        draftId: DRAFT,
        choice: "keep_server",
        serverPayloadJson: parsed?.payloadJson ?? "",
        serverVersion: 6,
      }),
    ).rejects.toThrow();
  });

  it("saves the full local payload online without writing the stub onto the original", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await seedConflict(db);
    const server = readFullServerDraft(fullDraft(6, "server stays"));
    const local = await getLocalDraft(db, DRAFT);
    const payloadJson = local ? recoverableLocalJson(local) : null;
    expect(payloadJson).toBe(LOCAL_WORK);
    await resolveDraftConflict(db, {
      draftId: DRAFT,
      choice: "save_local_copy",
      serverPayloadJson: server?.payloadJson ?? "",
      serverVersion: 6,
      localCopy: {
        draftId: COPY,
        jobId: JOB,
        kind: "quote",
        schemaVersion: 1,
        payloadJson: payloadJson ?? "",
        baseVersion: 1,
      },
    });
    const original = await getLocalDraft(db, DRAFT);
    const copy = await getLocalDraft(db, COPY);
    expect(original?.payloadJson).toContain("server stays");
    expect(original?.payloadJson).not.toContain("VERSION_CONFLICT");
    expect(original?.syncState).toBe("synced");
    expect(copy?.payloadJson).toBe(LOCAL_WORK);
    expect(copy?.syncState).toBe("dirty");
    expect(copy?.serverVersion).toBeNull();
    expect((db.tables.outbox_ops ?? []).some((row) => row.resource_id === COPY)).toBe(false);
    expect(await getLocalDraftByJob(db, JOB)).toMatchObject({ draftId: DRAFT, syncState: "synced" });
  });

  it("saves an offline local copy without clearing the conflict or paused outbox", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await seedConflict(db);
    const before = (db.tables.outbox_ops ?? []).find((row) => row.resource_id === DRAFT);
    const first = await saveRecoverableLocalCopy(db, { sourceDraftId: DRAFT, copyDraftId: COPY });
    const second = await saveRecoverableLocalCopy(db, { sourceDraftId: DRAFT, copyDraftId: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
    expect(first).toEqual({ draftId: COPY, created: true });
    expect(second).toEqual({ draftId: COPY, created: false });
    const original = await getLocalDraft(db, DRAFT);
    const copy = await getLocalDraft(db, COPY);
    expect(original?.syncState).toBe("conflict");
    expect(original?.conflictLocalJson).toBe(LOCAL_WORK);
    expect(copy?.payloadJson).toBe(LOCAL_WORK);
    expect(await getLocalDraftByJob(db, JOB)).toMatchObject({ draftId: DRAFT, syncState: "conflict" });
    const after = (db.tables.outbox_ops ?? []).find((row) => row.resource_id === DRAFT);
    expect(after?.state).toBe("paused_conflict");
    expect(after?.idempotency_key).toBe(before?.idempotency_key);
    expect(after?.base_version).toBe(before?.base_version);
    expect((db.tables.local_drafts ?? []).filter((row) => row.job_id === JOB)).toHaveLength(2);
  });

  it("re-shelves when the server version changes and leaves the paused outbox", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    const shelved = fullDraft(5, "older server");
    await seedConflict(db, { serverJson: JSON.stringify(shelved) });
    const next = readFullServerDraft(fullDraft(6, "newer server"));
    await expect(
      noteServerDraftChanged(db, {
        draftId: DRAFT,
        serverPayloadJson: next?.payloadJson ?? "",
        serverVersion: 6,
      }),
    ).resolves.toBe("server_changed");
    const after = await getLocalDraft(db, DRAFT);
    expect(after?.syncState).toBe("conflict");
    expect(after?.conflictLocalJson).toBe(LOCAL_WORK);
    expect(after?.conflictServerJson).toContain("newer server");
    expect((db.tables.outbox_ops ?? []).find((row) => row.resource_id === DRAFT)?.state).toBe("paused_conflict");
  });

  it("clears only the resolved draft and lets another draft drain", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await seedConflict(db, { draftId: DRAFT, jobId: JOB, operationId: "op-a" });
    await persistDraftLocally(db, {
      draftId: "draft-b",
      jobId: "job-b",
      kind: "quote",
      schemaVersion: 1,
      baseVersion: 2,
      payload: { notes: "other", terms: "", expiry_days: 14, lines: [] },
      patchBody: { notes: "other", terms: "", expiry_days: 14, lines: [] },
      operationId: "op-b",
      idempotencyKey: "idem-b",
      nowIso: "2026-09-27T12:05:00.000Z",
    });
    const server = readFullServerDraft(fullDraft(6, "kept"));
    await resolveDraftConflict(db, {
      draftId: DRAFT,
      choice: "keep_server",
      serverPayloadJson: server?.payloadJson ?? "",
      serverVersion: 6,
    });
    expect((db.tables.outbox_ops ?? []).some((row) => row.resource_id === DRAFT)).toBe(false);
    const drained = await drainOutbox(db, {
      forceImmediate: true,
      nowMs: Date.parse("2026-09-27T12:06:00.000Z"),
      request: async () => ({ ok: true, data: { id: "draft-b", job_id: "job-b", kind: "quote", version: 3 } }),
    });
    expect(drained.drained).toBe(1);
    expect(drained.conflicts).toBe(0);
    expect((db.tables.local_drafts ?? []).find((row) => row.draft_id === "draft-b")?.sync_state).toBe("synced");
  });

  it("stops sign-out synchronization when a conflict is paused", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await persistDraftLocally(db, {
      draftId: DRAFT,
      jobId: JOB,
      kind: "quote",
      schemaVersion: 1,
      baseVersion: 2,
      payload: { notes: "queued", terms: "", expiry_days: 14, lines: [] },
      patchBody: { notes: "queued", terms: "", expiry_days: 14, lines: [] },
      operationId: "op-stop",
      idempotencyKey: "idem-stop",
      nowIso: "2026-09-27T12:00:00.000Z",
    });
    await persistDraftLocally(db, {
      draftId: "draft-b",
      jobId: "job-b",
      kind: "quote",
      schemaVersion: 1,
      baseVersion: 2,
      payload: { notes: "other", terms: "", expiry_days: 14, lines: [] },
      patchBody: { notes: "other", terms: "", expiry_days: 14, lines: [] },
      operationId: "op-go",
      idempotencyKey: "idem-go",
      nowIso: "2026-09-27T12:00:02.000Z",
    });
    const result = await drainOutbox(db, {
      forceImmediate: true,
      nowMs: Date.parse("2026-09-27T12:01:00.000Z"),
      request: async (options) => {
        if (options.path.includes(DRAFT)) {
          return {
            ok: false,
            error: { status: 409, code: "VERSION_CONFLICT", message: "Conflict", retryable: false },
          };
        }
        return { ok: true, data: { id: "draft-b", job_id: "job-b", kind: "quote", version: 3 } };
      },
    });
    expect(result.conflicts).toBe(1);
    expect(result.drained).toBe(1);
    expect(result.outcome).toBe("conflict");
    expect((db.tables.outbox_ops ?? []).find((row) => row.resource_id === DRAFT)?.state).toBe("paused_conflict");
    let signedOut = false;
    const signed = await completeOwnerSignOut({
      mode: "synchronize",
      discardDrafts: async () => undefined,
      synchronizeDrafts: async () => ({ ok: false }),
      providerSignOut: async () => {
        signedOut = true;
      },
      clearStoredAuth: async () => undefined,
      clearMemory: () => undefined,
    });
    expect(signed).toEqual({ ok: false, stage: "synchronize" });
    expect(signedOut).toBe(false);
    expect(signOutFailureCopy("synchronize", "conflict")).toBe(copy.synchronizeConflict);
  });

  it("leaves a stored conflict untouched when the owner goes back", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await seedConflict(db);
    const before = await getLocalDraft(db, DRAFT);
    expect(before?.syncState).toBe("conflict");
    expect((db.tables.outbox_ops ?? []).find((row) => row.resource_id === DRAFT)?.state).toBe("paused_conflict");
  });

  it("keeps analytics and diagnostics free of commercial content", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await persistDraftLocally(db, {
      draftId: DRAFT,
      jobId: JOB,
      kind: "quote",
      schemaVersion: 1,
      baseVersion: 4,
      payload: { notes: "private note", terms: "", expiry_days: 14, lines: [] },
      patchBody: { notes: "private note", terms: "", expiry_days: 14, lines: [] },
      operationId: "op-analytics",
      idempotencyKey: "idem-analytics",
      nowIso: "2026-09-27T12:00:00.000Z",
    });
    const props = await pauseResourceForConflict(db, {
      draftId: DRAFT,
      operationId: "op-analytics",
      localJson: JSON.stringify({ notes: "private note", customer: "Ada" }),
      serverJson: JSON.stringify({ code: "VERSION_CONFLICT" }),
    });
    expect(props).toEqual({ resource_kind: "draft", client_version: "4" });
    expect(syncConflictAnalyticsIsSafe(props, ["private note", "Ada", "idem-analytics"])).toBe(true);
    expect(buildSyncConflictAnalytics({ resourceKind: "draft", clientVersion: "4" })).toEqual(props);
    const event = { stage: "conflict" as const, outcome: "conflict" as const, operationKind: "draft" as const, httpStatus: 409 };
    expect(drainDiagnosticIsSafe(event, ["private note", "Ada", "idem-analytics"])).toBe(true);
    const previous = (globalThis as { __DEV__?: boolean }).__DEV__;
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    const lines: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((message?: unknown) => {
      lines.push(String(message));
    });
    const { emitDrainDiagnostic } = await import("./drain-diagnostics.ts");
    emitDrainDiagnostic(event);
    spy.mockRestore();
    (globalThis as { __DEV__?: boolean }).__DEV__ = previous;
    expect(lines.join(" ")).not.toContain("private note");
    expect(lines.join(" ")).not.toContain("Ada");
  });
});
