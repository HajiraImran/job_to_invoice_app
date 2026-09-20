import { describe, expect, it } from "vitest";
import { decideDraftHydration, isLocalDraftUnacknowledged } from "./hydrate.ts";
import { reconcileServerDraftWithLocal } from "./reconcile.ts";
import { persistDraftLocally } from "./persist.ts";
import { getLocalDraft, upsertLocalDraft } from "./repository.ts";
import { resolveDraftConflict } from "../sync/conflict.ts";
import { getOpenOutboxForResource } from "../sync/outbox.ts";
import { migrateOwnerDatabase } from "../storage/schema.ts";
import { createMemorySqlite } from "../sync/memory-db.ts";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DRAFT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function patchNotes(notes: string) {
  return { notes, terms: "", expiry_days: 14, lines: [] };
}

function serverSnap(version: number, notes: string) {
  return {
    id: DRAFT,
    job_id: JOB,
    kind: "quote",
    schema_version: 1,
    version,
    payloadJson: JSON.stringify({
      id: DRAFT,
      job_id: JOB,
      kind: "quote",
      schema_version: 1,
      version,
      notes,
      terms: "",
      expiry_days: 14,
      lines: [],
    }),
  };
}

describe("SYNC01 draft hydration — server must not clobber pending local", () => {
  it("keeps newer pending local text when a delayed older server response arrives", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });

    // Local save: "Restart test 2026" pending with stable outbox op.
    const saved = await persistDraftLocally(db, {
      draftId: DRAFT,
      jobId: JOB,
      kind: "quote",
      schemaVersion: 1,
      baseVersion: 3,
      serverVersion: 3,
      payload: { id: DRAFT, job_id: JOB, notes: "Restart test 2026", version: 3, terms: "", expiry_days: 14, lines: [] },
      patchBody: patchNotes("Restart test 2026"),
      operationId: "op-stable",
      idempotencyKey: "idem-stable",
      nowIso: "2026-09-20T10:00:00.000Z",
    });
    expect(saved.status).toBe("saved_on_device");

    // Screen reopen: restore local first.
    const restored = await getLocalDraft(db, DRAFT);
    expect(restored?.payloadJson).toContain("Restart test 2026");
    expect(restored?.syncState).toBe("queued");

    // Delayed older server response (same base version, older notes).
    const afterServer = await reconcileServerDraftWithLocal(db, {
      jobId: JOB,
      server: serverSnap(3, "Older server notes"),
      nowIso: "2026-09-20T10:00:05.000Z",
    });
    expect(afterServer?.adoptedServer).toBe(false);
    expect(afterServer?.enteredConflict).toBe(false);
    expect(afterServer?.saveStatus).toBe("saved_on_device");
    expect(afterServer?.visible.payloadJson).toContain("Restart test 2026");
    expect(afterServer?.visible.payloadJson).not.toContain("Older server notes");

    const open = await getOpenOutboxForResource(db, DRAFT);
    expect(open?.operationId).toBe("op-stable");
    expect(open?.idempotencyKey).toBe("idem-stable");
    expect((db.tables.outbox_ops ?? []).filter((row) => row.resource_id === DRAFT && row.state !== "done")).toHaveLength(
      1,
    );
  });

  it("adopts server when there is no local draft", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    const result = await reconcileServerDraftWithLocal(db, {
      jobId: JOB,
      server: serverSnap(1, "Fresh from server"),
    });
    expect(result?.adoptedServer).toBe(true);
    expect(result?.visible.payloadJson).toContain("Fresh from server");
    expect(result?.saveStatus).toBe("synced");
  });

  it("adopts newer server when local draft is fully synced", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await upsertLocalDraft(db, {
      draftId: DRAFT,
      jobId: JOB,
      kind: "quote",
      baseVersion: 2,
      serverVersion: 2,
      schemaVersion: 1,
      payloadJson: JSON.stringify({ notes: "local synced" }),
      syncState: "synced",
    });
    const result = await reconcileServerDraftWithLocal(db, {
      jobId: JOB,
      server: serverSnap(4, "server newer"),
    });
    expect(result?.adoptedServer).toBe(true);
    expect(result?.visible.payloadJson).toContain("server newer");
    expect(result?.saveStatus).toBe("synced");
  });

  it("enters conflict when server version changed while local is pending", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await persistDraftLocally(db, {
      draftId: DRAFT,
      jobId: JOB,
      kind: "quote",
      schemaVersion: 1,
      baseVersion: 2,
      payload: patchNotes("pending local"),
      patchBody: patchNotes("pending local"),
      operationId: "op-c",
      idempotencyKey: "idem-c",
    });
    const result = await reconcileServerDraftWithLocal(db, {
      jobId: JOB,
      server: serverSnap(5, "server moved ahead"),
    });
    expect(result?.enteredConflict).toBe(true);
    expect(result?.saveStatus).toBe("conflict");
    expect(result?.visible.payloadJson).toContain("pending local");
    expect(result?.visible.conflictServerJson).toContain("server moved ahead");
  });

  it("Keep server replaces local payload and clears pending outbox", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await persistDraftLocally(db, {
      draftId: DRAFT,
      jobId: JOB,
      kind: "quote",
      schemaVersion: 1,
      baseVersion: 2,
      payload: patchNotes("pending local"),
      patchBody: patchNotes("pending local"),
      operationId: "op-keep",
      idempotencyKey: "idem-keep",
    });
    await reconcileServerDraftWithLocal(db, {
      jobId: JOB,
      server: serverSnap(5, "server wins"),
    });
    await expect(
      resolveDraftConflict(db, {
        draftId: DRAFT,
        choice: "keep_server",
        serverPayloadJson: serverSnap(5, "server wins").payloadJson,
        serverVersion: 5,
      }),
    ).resolves.toBe("kept_server");
    const after = await getLocalDraft(db, DRAFT);
    expect(after?.syncState).toBe("synced");
    expect(after?.payloadJson).toContain("server wins");
    expect(await getOpenOutboxForResource(db, DRAFT)).toBeNull();
  });

  it("Save local copy keeps local payload under a new draft id", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await persistDraftLocally(db, {
      draftId: DRAFT,
      jobId: JOB,
      kind: "quote",
      schemaVersion: 1,
      baseVersion: 2,
      payload: patchNotes("keep me locally"),
      patchBody: patchNotes("keep me locally"),
      operationId: "op-copy",
      idempotencyKey: "idem-copy",
    });
    await reconcileServerDraftWithLocal(db, {
      jobId: JOB,
      server: serverSnap(5, "server stays on original"),
    });
    const copyId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await expect(
      resolveDraftConflict(db, {
        draftId: DRAFT,
        choice: "save_local_copy",
        serverPayloadJson: serverSnap(5, "server stays on original").payloadJson,
        serverVersion: 5,
        localCopy: {
          draftId: copyId,
          jobId: JOB,
          kind: "quote",
          schemaVersion: 1,
          payloadJson: JSON.stringify({ notes: "keep me locally" }),
          baseVersion: 1,
        },
      }),
    ).resolves.toBe("saved_local_copy");
    const original = await getLocalDraft(db, DRAFT);
    const copy = await getLocalDraft(db, copyId);
    expect(original?.payloadJson).toContain("server stays on original");
    expect(original?.syncState).toBe("synced");
    expect(copy?.payloadJson).toContain("keep me locally");
    expect(copy?.syncState).toBe("dirty");
  });
});

describe("SYNC01 hydration decision unit rules", () => {
  it("treats dirty/queued/saving/conflict and open outbox as unacknowledged", () => {
    expect(
      isLocalDraftUnacknowledged(
        {
          draftId: DRAFT,
          jobId: JOB,
          kind: "quote",
          baseVersion: 1,
          serverVersion: 1,
          schemaVersion: 1,
          payloadJson: "{}",
          syncState: "queued",
          localUpdatedAt: "",
          conflictServerJson: null,
          conflictLocalJson: null,
        },
        false,
      ),
    ).toBe(true);
    expect(
      decideDraftHydration({
        local: {
          draftId: DRAFT,
          jobId: JOB,
          kind: "quote",
          baseVersion: 1,
          serverVersion: 1,
          schemaVersion: 1,
          payloadJson: JSON.stringify({ notes: "local" }),
          syncState: "synced",
          localUpdatedAt: "",
          conflictServerJson: null,
          conflictLocalJson: null,
        },
        server: serverSnap(1, "same"),
        hasOpenOutboxOperation: true,
      }),
    ).toMatchObject({ action: "keep_local", reason: "unacknowledged" });
  });
});
