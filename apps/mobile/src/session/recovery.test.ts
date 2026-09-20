import { describe, expect, it } from "vitest";
import { OFFLINE_READ_WINDOW_MS } from "@job-to-invoice/schemas";
import type { OwnerBootstrap } from "../api/client.ts";
import { presentJobsList } from "../jobs/presentation.ts";
import {
  createBootstrapGenerationGate,
  decideBootstrapApply,
  isAccessExpiredAfterFailure,
  offlineBannerVisible,
  outboxDrainEligibleAfterRecovery,
  retainOfflineCacheAfterFailure,
} from "./recovery.ts";

const OWNER: OwnerBootstrap = {
  user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "active", display_email: "owner@example.com" },
  workspace: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", version: 1, setup_completed: true },
  entitlement: { source: "free", can_publish: true },
  first_sign_in: false,
  analytics_alias_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

const QUEUED_DRAFT = {
  operationId: "op-draft-1",
  idempotencyKey: "idem-draft-1",
  baseVersion: 4,
  payload: { notes: "unsynced local edit" },
};

describe("bootstrap recovery from offline_cached", () => {
  it("replaces offline_cached with authenticated on successful /v1/me 200", () => {
    const gate = createBootstrapGenerationGate();
    const generation = gate.begin();
    const decision = decideBootstrapApply({
      generation,
      gate,
      result: { ok: true, data: OWNER },
      authenticatedAt: "2026-09-20T12:00:00.000Z",
      lastAuthenticatedAt: "2026-09-18T12:00:00.000Z",
      cachedBootstrap: OWNER,
      nowMs: Date.parse("2026-09-20T12:00:00.000Z"),
      supportCode: "BOOTSTRAP_NETWORK",
    });
    expect(decision.action).toBe("apply_success");
    if (decision.action === "apply_success") {
      expect(decision.snapshot.status).toBe("authenticated");
      expect(decision.snapshot.lastAuthenticatedAt).toBe("2026-09-20T12:00:00.000Z");
      expect(decision.authenticatedAt).toBe("2026-09-20T12:00:00.000Z");
      expect(decision.bootstrap).toEqual(OWNER);
      expect(decision.enableOutboxDrain).toBe(true);
      gate.markApplied(generation);
    }
    expect(offlineBannerVisible("authenticated")).toBe(false);
    expect(outboxDrainEligibleAfterRecovery("authenticated")).toBe(true);
    expect(
      presentJobsList({
        authStatus: "authenticated",
        loading: false,
        loadedOnce: true,
        items: [],
        searching: false,
      }).showOfflineBanner,
    ).toBe(false);
  });

  it("successful recovery updates authorization timestamp and enables outbox drain", () => {
    const gate = createBootstrapGenerationGate();
    const generation = gate.begin();
    const before = "2026-09-10T12:00:00.000Z";
    const after = "2026-09-20T15:00:00.000Z";
    const decision = decideBootstrapApply({
      generation,
      gate,
      result: { ok: true, data: OWNER },
      authenticatedAt: after,
      lastAuthenticatedAt: before,
      cachedBootstrap: OWNER,
      nowMs: Date.parse(after),
      supportCode: "BOOTSTRAP_NETWORK",
    });
    expect(decision.action).toBe("apply_success");
    if (decision.action === "apply_success") {
      expect(decision.snapshot.lastAuthenticatedAt).toBe(after);
      expect(decision.snapshot.lastAuthenticatedAt).not.toBe(before);
      expect(outboxDrainEligibleAfterRecovery(decision.snapshot.status)).toBe(true);
    }
  });

  it("Jobs presentation removes the offline banner after recovery", () => {
    const job = {
      id: "1",
      customer_id: "c",
      customer_name: "Ada",
      title: "Roof",
      lifecycle: "active",
      mode: "quote",
      no_site: true,
      version: 1,
      created_at: "2026-09-20T00:00:00.000Z",
      updated_at: "2026-09-20T00:00:00.000Z",
    };
    const offline = presentJobsList({
      authStatus: "offline_cached",
      loading: false,
      loadedOnce: true,
      items: [job],
      searching: false,
    });
    expect(offline.showOfflineBanner).toBe(true);
    const online = presentJobsList({
      authStatus: "authenticated",
      loading: false,
      loadedOnce: true,
      items: [job],
      searching: false,
    });
    expect(online.showOfflineBanner).toBe(false);
  });

  it("older failed request cannot overwrite a newer successful recovery", () => {
    const gate = createBootstrapGenerationGate();
    const older = gate.begin();
    const newer = gate.begin();

    const success = decideBootstrapApply({
      generation: newer,
      gate,
      result: { ok: true, data: OWNER },
      authenticatedAt: "2026-09-20T12:00:01.000Z",
      lastAuthenticatedAt: "2026-09-18T12:00:00.000Z",
      cachedBootstrap: OWNER,
      nowMs: Date.parse("2026-09-20T12:00:01.000Z"),
      supportCode: "BOOTSTRAP_NETWORK",
    });
    expect(success.action).toBe("apply_success");
    gate.markApplied(newer);

    const staleFailure = decideBootstrapApply({
      generation: older,
      gate,
      result: { ok: false, error: { status: 0, code: "UNAVAILABLE" } },
      authenticatedAt: "2026-09-20T12:00:02.000Z",
      lastAuthenticatedAt: "2026-09-18T12:00:00.000Z",
      cachedBootstrap: OWNER,
      nowMs: Date.parse("2026-09-20T12:00:02.000Z"),
      supportCode: "BOOTSTRAP_NETWORK",
    });
    expect(staleFailure.action).toBe("ignore_stale");
  });

  it("failed recovery retains permitted offline state inside seven days", () => {
    const gate = createBootstrapGenerationGate();
    const generation = gate.begin();
    const last = "2026-09-18T12:00:00.000Z";
    const nowMs = Date.parse("2026-09-20T12:00:00.000Z");
    expect(
      retainOfflineCacheAfterFailure({
        lastAuthenticatedAt: last,
        nowMs,
        hasCachedBootstrap: true,
        sessionFailure: false,
      }),
    ).toBe(true);

    const decision = decideBootstrapApply({
      generation,
      gate,
      result: { ok: false, error: { status: 0, code: "UNAVAILABLE" } },
      authenticatedAt: new Date(nowMs).toISOString(),
      lastAuthenticatedAt: last,
      cachedBootstrap: OWNER,
      nowMs,
      supportCode: "BOOTSTRAP_NETWORK",
    });
    expect(decision.action).toBe("apply_failure");
    if (decision.action === "apply_failure") {
      expect(decision.snapshot.status).toBe("offline_cached");
      expect(decision.bootstrap).toEqual(OWNER);
      expect(decision.enableOutboxDrain).toBe(false);
      expect(offlineBannerVisible(decision.snapshot.status)).toBe(true);
    }
  });

  it("expiry still blocks cache after seven days", () => {
    const last = "2026-09-01T12:00:00.000Z";
    const nowMs = Date.parse(last) + OFFLINE_READ_WINDOW_MS + 1;
    expect(
      retainOfflineCacheAfterFailure({
        lastAuthenticatedAt: last,
        nowMs,
        hasCachedBootstrap: true,
        sessionFailure: false,
      }),
    ).toBe(false);
    expect(
      isAccessExpiredAfterFailure({
        lastAuthenticatedAt: last,
        nowMs,
        sessionFailure: true,
      }),
    ).toBe(true);

    const gate = createBootstrapGenerationGate();
    const generation = gate.begin();
    const decision = decideBootstrapApply({
      generation,
      gate,
      result: { ok: false, error: { status: 0, code: "UNAVAILABLE" } },
      authenticatedAt: new Date(nowMs).toISOString(),
      lastAuthenticatedAt: last,
      cachedBootstrap: OWNER,
      nowMs,
      supportCode: "BOOTSTRAP_NETWORK",
    });
    expect(decision.action).toBe("apply_failure");
    if (decision.action === "apply_failure") {
      expect(decision.snapshot.status).toBe("bootstrap_error");
    }
  });

  it("coalesces concurrent generations so only one failure/success applies from the latest wave", () => {
    const gate = createBootstrapGenerationGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.latestStarted).toBe(2);

    const ignoredOlderFailure = decideBootstrapApply({
      generation: first,
      gate,
      result: { ok: false, error: { status: 0, code: "UNAVAILABLE" } },
      authenticatedAt: "2026-09-20T12:00:00.000Z",
      lastAuthenticatedAt: "2026-09-18T12:00:00.000Z",
      cachedBootstrap: OWNER,
      nowMs: Date.parse("2026-09-20T12:00:00.000Z"),
      supportCode: "BOOTSTRAP_NETWORK",
    });
    expect(ignoredOlderFailure.action).toBe("ignore_stale");

    const latestSuccess = decideBootstrapApply({
      generation: second,
      gate,
      result: { ok: true, data: OWNER },
      authenticatedAt: "2026-09-20T12:00:01.000Z",
      lastAuthenticatedAt: "2026-09-18T12:00:00.000Z",
      cachedBootstrap: OWNER,
      nowMs: Date.parse("2026-09-20T12:00:01.000Z"),
      supportCode: "BOOTSTRAP_NETWORK",
    });
    expect(latestSuccess.action).toBe("apply_success");
  });

  it("queued commercial draft identity remains unchanged during state recovery", () => {
    const before = { ...QUEUED_DRAFT };
    const gate = createBootstrapGenerationGate();
    const generation = gate.begin();
    decideBootstrapApply({
      generation,
      gate,
      result: { ok: true, data: OWNER },
      authenticatedAt: "2026-09-20T12:00:00.000Z",
      lastAuthenticatedAt: "2026-09-18T12:00:00.000Z",
      cachedBootstrap: OWNER,
      nowMs: Date.parse("2026-09-20T12:00:00.000Z"),
      supportCode: "BOOTSTRAP_NETWORK",
    });
    expect(QUEUED_DRAFT).toEqual(before);
    expect(QUEUED_DRAFT.operationId).toBe("op-draft-1");
    expect(QUEUED_DRAFT.idempotencyKey).toBe("idem-draft-1");
    expect(QUEUED_DRAFT.baseVersion).toBe(4);
  });
});
