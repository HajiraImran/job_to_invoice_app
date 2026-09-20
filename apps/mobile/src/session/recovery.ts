/**
 * Owner bootstrap recovery transitions (ACC02 / S02).
 * Successful /v1/me must replace offline_cached; older failures must not clobber newer success.
 */

import {
  isOfflineReadPermitted,
  type AuthSnapshot,
  type BootstrapSupportCode,
} from "@job-to-invoice/schemas";
import type { OwnerBootstrap } from "../api/client.ts";
import { snapshotAfterBootstrapFailure } from "./bootstrap.ts";
import { snapshotFromBootstrap } from "./logic.ts";

export type BootstrapApplyDecision =
  | { action: "ignore_stale" }
  | {
      action: "apply_success";
      snapshot: AuthSnapshot;
      bootstrap: OwnerBootstrap;
      authenticatedAt: string;
      enableOutboxDrain: true;
    }
  | {
      action: "apply_failure";
      snapshot: AuthSnapshot;
      bootstrap?: OwnerBootstrap;
      supportCode: BootstrapSupportCode;
      enableOutboxDrain: false;
    };

/**
 * Monotonic generation gate: each in-flight /v1/me claims a generation.
 * - Success applies when generation >= last applied (refreshes online state).
 * - Failure applies only for the latest started generation and never when
 *   generation < last applied (so a delayed failure cannot restore offline_cached
 *   after a newer 200).
 */
export function createBootstrapGenerationGate() {
  let latestStarted = 0;
  let latestApplied = 0;

  return {
    begin(): number {
      latestStarted += 1;
      return latestStarted;
    },
    canApplySuccess(generation: number): boolean {
      return generation >= latestApplied;
    },
    canApplyFailure(generation: number): boolean {
      return generation === latestStarted && generation > latestApplied;
    },
    /** @deprecated use canApplySuccess / canApplyFailure */
    canApply(generation: number): boolean {
      return generation === latestStarted && generation > latestApplied;
    },
    markApplied(generation: number): void {
      if (generation > latestApplied) {
        latestApplied = generation;
      }
    },
    get latestStarted() {
      return latestStarted;
    },
    get latestApplied() {
      return latestApplied;
    },
  };
}

export type BootstrapGenerationGate = ReturnType<typeof createBootstrapGenerationGate>;

export function decideBootstrapApply(input: {
  generation: number;
  gate: Pick<BootstrapGenerationGate, "canApplySuccess" | "canApplyFailure">;
  result: { ok: true; data: OwnerBootstrap } | { ok: false; error: { status: number; code: string } };
  authenticatedAt: string;
  emailHint?: string;
  lastAuthenticatedAt?: string;
  cachedBootstrap?: OwnerBootstrap | null;
  nowMs: number;
  supportCode: BootstrapSupportCode;
}): BootstrapApplyDecision {
  if (input.result.ok) {
    if (!input.gate.canApplySuccess(input.generation)) {
      return { action: "ignore_stale" };
    }
    return {
      action: "apply_success",
      snapshot: snapshotFromBootstrap(input.result.data, input.authenticatedAt),
      bootstrap: input.result.data,
      authenticatedAt: input.authenticatedAt,
      enableOutboxDrain: true,
    };
  }

  if (!input.gate.canApplyFailure(input.generation)) {
    return { action: "ignore_stale" };
  }

  const nextSnap = snapshotAfterBootstrapFailure({
    supportCode: input.supportCode,
    emailDisplay: input.emailHint?.trim() || undefined,
    lastAuthenticatedAt: input.lastAuthenticatedAt,
    nowMs: input.nowMs,
    hasCachedBootstrap: Boolean(input.cachedBootstrap),
  });

  if (nextSnap.status === "offline_cached" && input.cachedBootstrap) {
    return {
      action: "apply_failure",
      snapshot: {
        ...nextSnap,
        setupCompleted: input.cachedBootstrap.workspace.setup_completed,
        emailDisplay: input.cachedBootstrap.user.display_email,
      },
      bootstrap: input.cachedBootstrap,
      supportCode: input.supportCode,
      enableOutboxDrain: false,
    };
  }

  return {
    action: "apply_failure",
    snapshot: {
      ...nextSnap,
      status: nextSnap.status === "access_expired" ? "access_expired" : "bootstrap_error",
      emailDisplay: nextSnap.emailDisplay ?? (input.emailHint?.trim() || undefined),
      supportCode: input.supportCode,
    },
    supportCode: input.supportCode,
    enableOutboxDrain: false,
  };
}

/** Jobs / commercial UI: offline banner only while auth status is offline_cached. */
export function offlineBannerVisible(authStatus: string): boolean {
  return authStatus === "offline_cached";
}

/** After a successful online recovery, queued draft drain is eligible. */
export function outboxDrainEligibleAfterRecovery(authStatus: string): boolean {
  return authStatus === "authenticated";
}

/**
 * Whether a failed recovery may keep showing encrypted commercial cache.
 * Mirrors ACC02 seven-day window.
 */
export function retainOfflineCacheAfterFailure(input: {
  lastAuthenticatedAt?: string;
  nowMs: number;
  hasCachedBootstrap: boolean;
  sessionFailure: boolean;
}): boolean {
  if (input.sessionFailure || !input.hasCachedBootstrap) {
    return false;
  }
  return isOfflineReadPermitted(input.lastAuthenticatedAt, input.nowMs);
}

export function isAccessExpiredAfterFailure(input: {
  lastAuthenticatedAt?: string;
  nowMs: number;
  sessionFailure: boolean;
}): boolean {
  if (!input.sessionFailure || !input.lastAuthenticatedAt) {
    return false;
  }
  return !isOfflineReadPermitted(input.lastAuthenticatedAt, input.nowMs);
}
