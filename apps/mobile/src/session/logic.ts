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

export const SIGNED_OUT_WELCOME_HREF = "/(public)/welcome";
export const SIGNED_OUT_SIGN_IN_HREF = "/(public)/sign-in";
export const VERIFY_HREF = "/(public)/verify";
export const ONBOARDING_HREF = "/(onboarding)/setup";
export const APP_JOBS_HREF = "/(tabs)/jobs";

export type OwnerGuardDecision =
  | { action: "hold" }
  | { action: "stay" }
  | {
      action: "replace";
      href:
        | typeof SIGNED_OUT_WELCOME_HREF
        | typeof SIGNED_OUT_SIGN_IN_HREF
        | typeof VERIFY_HREF
        | typeof ONBOARDING_HREF
        | typeof APP_JOBS_HREF;
    };

export function resolveOwnerGuard(input: {
  snapshot: AuthSnapshot;
  segments: readonly string[];
}): OwnerGuardDecision {
  if (input.snapshot.status === "restoring" || input.snapshot.status === "authenticating") {
    return { action: "hold" };
  }
  const group = routeGroupFor(input.snapshot);
  const root = input.segments[0];
  const page = input.segments[1];
  if (group === "public" && page === "verify") {
    return { action: "replace", href: SIGNED_OUT_SIGN_IN_HREF };
  }
  if (group === "public" && root !== "(public)") {
    return { action: "replace", href: SIGNED_OUT_WELCOME_HREF };
  }
  if (group === "verify" && page !== "verify") {
    return { action: "replace", href: VERIFY_HREF };
  }
  if (group === "onboarding" && root !== "(onboarding)") {
    return { action: "replace", href: ONBOARDING_HREF };
  }
  if (group === "app" && root !== "(tabs)") {
    return { action: "replace", href: APP_JOBS_HREF };
  }
  return { action: "stay" };
}
