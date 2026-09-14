import {
  OTP_MAX_FAILURES,
  canResend,
  isOfflineReadPermitted,
  resendAvailableAt,
  routeGroupFor,
  type AuthSnapshot,
  type RouteGroup,
} from "@job-to-invoice/schemas";
import type { OwnerBootstrap } from "../api/client.ts";

export function snapshotFromBootstrap(
  bootstrap: OwnerBootstrap,
  lastAuthenticatedAt: string,
): AuthSnapshot {
  return {
    status: "authenticated",
    emailDisplay: bootstrap.user.display_email,
    setupCompleted: bootstrap.workspace.setup_completed,
    lastAuthenticatedAt,
  };
}

export function snapshotAfterRefreshFailure(lastAuthenticatedAt: string | undefined, nowMs: number): AuthSnapshot {
  if (isOfflineReadPermitted(lastAuthenticatedAt, nowMs)) {
    return { status: "offline_cached", lastAuthenticatedAt };
  }
  return { status: "access_expired" };
}

export function canSubmitCode(code: string, failures: number, submitting: boolean): boolean {
  return /^\d{6}$/.test(code) && failures < OTP_MAX_FAILURES && !submitting;
}

export function nextFailures(current: number): number {
  return current + 1;
}

export function attemptsExceeded(failures: number): boolean {
  return failures >= OTP_MAX_FAILURES;
}

export function canRequestCode(nowMs: number, availableAt?: number, submitting?: boolean): boolean {
  return !submitting && canResend(nowMs, availableAt);
}

export function awaitingCodeSnapshot(emailDisplay: string, sentAtMs: number): AuthSnapshot {
  return {
    status: "awaiting_code",
    emailDisplay,
    resendAvailableAt: resendAvailableAt(sentAtMs),
    verifyFailures: 0,
  };
}

export function routeAfterAuth(snapshot: AuthSnapshot): RouteGroup {
  return routeGroupFor(snapshot);
}
