import { copy } from "../i18n/en.ts";
import type { ApiError } from "./client.ts";

export type Reachability = "online" | "offline";

export const REACHABILITY_PROBE_TIMEOUT_MS = 4_000;
export const REACHABILITY_CACHE_MS = 10_000;

/**
 * Any HTTP answer from the auth host proves the device has internet access, so a
 * failed API call is then "API unreachable" rather than "offline". No auth material is sent.
 */
export async function probeInternet(options: {
  url: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<Reachability> {
  if (!options.url) {
    return "online";
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = typeof AbortController === "function" ? new AbortController() : undefined;
  const timer = setTimeout(() => controller?.abort(), options.timeoutMs ?? REACHABILITY_PROBE_TIMEOUT_MS);
  try {
    await fetchImpl(options.url, { method: "GET", signal: controller?.signal });
    return "online";
  } catch {
    return "offline";
  } finally {
    clearTimeout(timer);
  }
}

export function authHealthUrl(authProjectUrl: string): string {
  return authProjectUrl ? `${authProjectUrl.replace(/\/+$/, "")}/auth/v1/health` : "";
}

export function createReachabilityCheck(
  probe: () => Promise<Reachability>,
  options: { cacheMs?: number; now?: () => number } = {},
): () => Promise<Reachability> {
  const cacheMs = options.cacheMs ?? REACHABILITY_CACHE_MS;
  const now = options.now ?? Date.now;
  let cached: { value: Reachability; at: number } | undefined;
  let inFlight: Promise<Reachability> | undefined;
  return async () => {
    if (cached && now() - cached.at < cacheMs) {
      return cached.value;
    }
    inFlight ??= probe()
      .then((value) => {
        cached = { value, at: now() };
        return value;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

/** Refines an "unreachable" status-0 failure into "offline" when the internet itself is down. */
export async function refineNetworkFailure(
  error: ApiError,
  check: () => Promise<Reachability>,
): Promise<ApiError> {
  if (error.status !== 0 || error.network !== "unreachable") {
    return error;
  }
  return (await check()) === "offline" ? { ...error, network: "offline" } : error;
}

export function requestFailureMessage(error: ApiError): string {
  if (error.status === 0) {
    if (error.network === "offline") {
      return copy.apiOffline;
    }
    if (error.network === "timeout") {
      return copy.apiTimedOut;
    }
    return copy.apiUnreachable;
  }
  if (error.code === "DATABASE_TIMEOUT" || error.code === "DATABASE_UNAVAILABLE") {
    return copy.apiDatabase;
  }
  return error.message;
}
