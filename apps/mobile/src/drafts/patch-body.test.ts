import { describe, expect, it, vi } from "vitest";
import { parseDraftPayload } from "@job-to-invoice/schemas";
import { createMemorySqlite } from "../sync/memory-db.ts";
import { migrateOwnerDatabase } from "../storage/schema.ts";
import { persistDraftLocally, drainOutbox } from "./persist.ts";
import { ownerDraftPatchBodyFromStored, isOwnerDraftPatchBody } from "./patch-body.ts";
import { enqueueOutboxOperation, coalesceOpenOutboxOperations } from "../sync/outbox.ts";
import { pauseResourceForConflict } from "../sync/conflict.ts";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LINE_ID = "11111111-1111-4111-8111-111111111111";

const ONLINE_PATCH = {
  notes: "offline edit",
  terms: "Net 14",
  expiry_days: 14,
  lines: [
    {
      client_line_id: LINE_ID,
      description: "Labor",
      unit: "hour" as const,
      custom_unit_label: null,
      quantity: "2",
      unit_price_cents: 5000,
      discount_cents: 0,
      tax_bp: 0,
    },
  ],
};

const RICH_LOCAL = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  job_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  kind: "quote",
  draft_state: "open",
  schema_version: 1,
  version: 3,
  default_tax_bp: 0,
  currency: "USD",
  net_cents: 10000,
  tax_cents: 0,
  total_cents: 10000,
  ...ONLINE_PATCH,
  lines: ONLINE_PATCH.lines.map((line) => ({
    ...line,
    gross_cents: 10000,
    net_cents: 10000,
    tax_cents: 0,
    total_cents: 10000,
  })),
};

describe("outbox draft PATCH body contract", () => {
  it("maps rich local snapshots to the online PATCH body", () => {
    const online = parseDraftPayload(ONLINE_PATCH);
    expect(online.ok).toBe(true);
    const mapped = ownerDraftPatchBodyFromStored(RICH_LOCAL);
    expect(mapped.ok).toBe(true);
    if (mapped.ok && online.ok) {
      expect(mapped.value).toEqual(online.value);
    }
    expect(isOwnerDraftPatchBody(RICH_LOCAL)).toBe(false);
    expect(isOwnerDraftPatchBody(ONLINE_PATCH)).toBe(true);
  });

  it("offline replay issues one authenticated PATCH matching the online contract", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    const opId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const key = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    const saved = await persistDraftLocally(db, {
      draftId: RICH_LOCAL.id,
      jobId: RICH_LOCAL.job_id,
      kind: "quote",
      schemaVersion: 1,
      baseVersion: 3,
      payload: RICH_LOCAL,
      patchBody: ONLINE_PATCH,
      operationId: opId,
      idempotencyKey: key,
      nowIso: "2026-09-20T14:00:00.000Z",
    });
    expect(saved.status).toBe("saved_on_device");
    const stored = JSON.parse(String(db.tables.outbox_ops?.[0]?.body_json));
    expect(Object.keys(stored).sort()).toEqual(["expiry_days", "lines", "notes", "terms"]);
    expect(stored).not.toHaveProperty("id");
    expect(stored).not.toHaveProperty("version");
    expect(stored.lines[0]).not.toHaveProperty("gross_cents");

    const requests: Array<{
      method?: string;
      path: string;
      body?: unknown;
      idempotencyKey?: string;
      ifMatch?: string | number;
    }> = [];
    const drained = await drainOutbox(db, {
      forceImmediate: true,
      nowMs: Date.parse("2026-09-20T14:00:00.000Z"),
      request: async (options) => {
        requests.push(options);
        return { ok: true, data: { ...RICH_LOCAL, version: 4, notes: "offline edit" } };
      },
    });
    expect(drained.remaining).toBe(0);
    expect(drained.drained).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.path).toBe(`/v1/drafts/${RICH_LOCAL.id}`);
    expect(requests[0]?.idempotencyKey).toBe(key);
    expect(requests[0]?.ifMatch).toBe(3);
    expect(requests[0]?.body).toEqual(ONLINE_PATCH);
    expect((db.tables.local_drafts ?? [])[0]?.sync_state).toBe("synced");
    expect((db.tables.outbox_ops ?? [])[0]?.operation_id).toBe(opId);
    expect((db.tables.outbox_ops ?? [])[0]?.idempotency_key).toBe(key);
  });

  it("maps already-queued rich bodyJson on drain without requiring re-save", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await enqueueOutboxOperation(db, {
      operationId: "op-legacy",
      resourceKind: "draft",
      resourceId: RICH_LOCAL.id,
      method: "PATCH",
      path: `/v1/drafts/${RICH_LOCAL.id}`,
      bodyJson: JSON.stringify(RICH_LOCAL),
      baseVersion: 3,
      idempotencyKey: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
      nowIso: "2026-09-20T14:00:00.000Z",
    });
    const bodies: unknown[] = [];
    const drained = await drainOutbox(db, {
      forceImmediate: true,
      nowMs: Date.parse("2026-09-20T14:00:00.000Z"),
      request: async (options) => {
        bodies.push(options.body);
        return { ok: true, data: { version: 4 } };
      },
    });
    expect(drained.drained).toBe(1);
    expect(bodies[0]).toEqual(ONLINE_PATCH);
  });

  it("422 leaves data recoverable and does not retry endlessly", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await persistDraftLocally(db, {
      draftId: RICH_LOCAL.id,
      jobId: RICH_LOCAL.job_id,
      kind: "quote",
      schemaVersion: 1,
      baseVersion: 3,
      payload: RICH_LOCAL,
      patchBody: ONLINE_PATCH,
      operationId: "op-422",
      idempotencyKey: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
      nowIso: "2026-09-20T14:00:00.000Z",
    });
    const request = vi.fn(async () => ({
      ok: false as const,
      error: {
        status: 422,
        code: "VALIDATION_FAILED",
        message: "Check the highlighted fields.",
        retryable: false,
      },
    }));
    const first = await drainOutbox(db, {
      forceImmediate: true,
      nowMs: Date.parse("2026-09-20T14:00:00.000Z"),
      request,
    });
    expect(first.outcome).toBe("validation_failure");
    expect(first.remaining).toBe(1);
    expect((db.tables.outbox_ops ?? [])[0]?.state).toBe("failed");
    expect((db.tables.local_drafts ?? [])[0]?.sync_state).toBe("queued");
    expect(String((db.tables.local_drafts ?? [])[0]?.payload_json)).toContain("offline edit");

    const second = await drainOutbox(db, {
      forceImmediate: true,
      nowMs: Date.parse("2026-09-20T14:01:00.000Z"),
      request,
    });
    expect(second.drained).toBe(0);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("coalesces multiple open ops for one draft and keeps stable identity on supersede", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await enqueueOutboxOperation(db, {
      operationId: "op-old",
      resourceKind: "draft",
      resourceId: RICH_LOCAL.id,
      method: "PATCH",
      path: `/v1/drafts/${RICH_LOCAL.id}`,
      bodyJson: JSON.stringify({ ...ONLINE_PATCH, notes: "old" }),
      baseVersion: 2,
      idempotencyKey: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
      nowIso: "2026-09-20T13:00:00.000Z",
    });
    await enqueueOutboxOperation(db, {
      operationId: "op-new",
      resourceKind: "draft",
      resourceId: RICH_LOCAL.id,
      method: "PATCH",
      path: `/v1/drafts/${RICH_LOCAL.id}`,
      bodyJson: JSON.stringify(ONLINE_PATCH),
      baseVersion: 3,
      idempotencyKey: "ffffffff-ffff-4fff-8fff-fffffffffff1",
      nowIso: "2026-09-20T14:00:00.000Z",
    });
    const open = (db.tables.outbox_ops ?? []).filter((row) =>
      ["pending", "failed"].includes(String(row.state)),
    );
    expect(open).toHaveLength(1);
    expect(open[0]?.operation_id).toBe("op-old");
    expect(open[0]?.idempotency_key).toBe("ffffffff-ffff-4fff-8fff-fffffffffff1");
    expect(String(open[0]?.body_json)).toContain('"notes":"offline edit"');
    expect(open[0]?.base_version).toBe(3);

    const superseded = await coalesceOpenOutboxOperations(db, "2026-09-20T14:00:01.000Z");
    expect(superseded).toBe(0);
  });

  it("409 still preserves the local conflict copy", async () => {
    const db = createMemorySqlite();
    await migrateOwnerDatabase(db, { ownerId: OWNER, workspaceId: WORKSPACE });
    await persistDraftLocally(db, {
      draftId: RICH_LOCAL.id,
      jobId: RICH_LOCAL.job_id,
      kind: "quote",
      schemaVersion: 1,
      baseVersion: 3,
      payload: RICH_LOCAL,
      patchBody: ONLINE_PATCH,
      operationId: "op-409",
      idempotencyKey: "99999999-9999-4999-8999-999999999991",
      nowIso: "2026-09-20T14:00:00.000Z",
    });
    const conflicted = await drainOutbox(db, {
      forceImmediate: true,
      nowMs: Date.parse("2026-09-20T14:00:00.000Z"),
      request: async () => ({
        ok: false,
        error: { status: 409, code: "VERSION_CONFLICT", message: "Conflict", retryable: false },
      }),
    });
    expect(conflicted.conflicts).toBe(1);
    expect((db.tables.local_drafts ?? [])[0]?.sync_state).toBe("conflict");
    expect(String((db.tables.local_drafts ?? [])[0]?.conflict_local_json)).toContain("notes");
    await expect(
      pauseResourceForConflict(db, {
        draftId: RICH_LOCAL.id,
        operationId: "op-409",
        localJson: JSON.stringify(ONLINE_PATCH),
        serverJson: JSON.stringify({ notes: "server" }),
        nowIso: "2026-09-20T14:00:02.000Z",
      }),
    ).resolves.toMatchObject({ resource_kind: "draft" });
  });
});
