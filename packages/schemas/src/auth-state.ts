export const RESEND_COOLDOWN_MS = 60_000;
export const OTP_LENGTH = 6;
export const OTP_MAX_FAILURES = 5;
export const OFFLINE_READ_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type AuthStatus =
  | "restoring"
  | "signed_out"
  | "awaiting_code"
  | "authenticating"
  | "bootstrap_error"
  | "authenticated"
  | "offline_cached"
  | "access_expired";

export type RouteGroup = "splash" | "public" | "verify" | "onboarding" | "app";

export type AuthSnapshot = {
  status: AuthStatus;
  emailDisplay?: string;
  setupCompleted?: boolean;
  lastAuthenticatedAt?: string;
  verifyFailures?: number;
  resendAvailableAt?: number;
};

export function resendAvailableAt(sentAtMs: number): number {
  return sentAtMs + RESEND_COOLDOWN_MS;
}

export function canResend(nowMs: number, availableAt?: number): boolean {
  return availableAt === undefined || nowMs >= availableAt;
}

export function remainingResendSeconds(nowMs: number, availableAt?: number): number {
  if (availableAt === undefined) {
    return 0;
  }
  return Math.max(0, Math.ceil((availableAt - nowMs) / 1000));
}

export function isOfflineReadPermitted(lastAuthenticatedAt: string | undefined, nowMs: number): boolean {
  if (!lastAuthenticatedAt) {
    return false;
  }
  const last = Date.parse(lastAuthenticatedAt);
  if (Number.isNaN(last)) {
    return false;
  }
  return nowMs - last <= OFFLINE_READ_WINDOW_MS;
}

export function routeGroupFor(snapshot: AuthSnapshot): RouteGroup {
  switch (snapshot.status) {
    case "restoring":
      return "splash";
    case "awaiting_code":
    case "bootstrap_error":
      return "verify";
    case "authenticating":
      return "splash";
    case "authenticated":
      return snapshot.setupCompleted === true ? "app" : "onboarding";
    case "offline_cached":
      return snapshot.setupCompleted === true ? "app" : "onboarding";
    case "access_expired":
    case "signed_out":
      return "public";
    default:
      return "public";
  }
}

export function publicRouteAllowed(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname.startsWith("/(public)") ||
    pathname === "/welcome" ||
    pathname === "/sign-in" ||
    pathname === "/verify"
  );
}

export function signOutClears(): readonly string[] {
  return [
    "session",
    "access_token",
    "refresh_token",
    "bootstrap",
    "in_memory_auth",
  ];
}

export type DraftSyncStatus = {
  hasUnsyncedDrafts: boolean;
  synchronizeAvailable: boolean;
};

export const EMPTY_DRAFT_SYNC: DraftSyncStatus = {
  hasUnsyncedDrafts: false,
  synchronizeAvailable: false,
};
