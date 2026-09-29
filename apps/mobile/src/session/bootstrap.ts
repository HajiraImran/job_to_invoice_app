import {
  BOOTSTRAP_SUPPORT_CODES,
  isOfflineReadPermitted,
  type AuthSnapshot,
  type BootstrapSupportCode,
} from "@job-to-invoice/schemas";
import { copy } from "../i18n/en.ts";
import type { ApiError, OwnerBootstrap } from "../api/client.ts";

export type OwnerMeOk = { ok: true; data: OwnerBootstrap };
export type OwnerMeFail = { ok: false; error: ApiError };
export type OwnerMeResponse = OwnerMeOk | OwnerMeFail;

export type FetchOwnerMeResult = OwnerMeResponse & { refreshCount: number };

export { BOOTSTRAP_SUPPORT_CODES };
export type { BootstrapSupportCode };

export const OWNER_ME_TIMEOUT_MS = 15_000;

const NETWORK_UNAVAILABLE: ApiError = {
  status: 0,
  code: "UNAVAILABLE",
  message: copy.networkError,
  retryable: true,
};

export type OwnerMeTimer = (onTimeout: () => void, ms: number) => () => void;

export type FetchOwnerMeOptions = {
  apiBaseUrl: string;
  accessToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  startTimer?: OwnerMeTimer;
  clientRequestId?: string;
};

function defaultStartTimer(onTimeout: () => void, ms: number): () => void {
  const id = setTimeout(onTimeout, ms);
  return () => clearTimeout(id);
}

export function isUsableOwnerBootstrap(data: unknown): data is OwnerBootstrap {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  const record = data as Record<string, unknown>;
  const user = record.user;
  const workspace = record.workspace;
  const entitlement = record.entitlement;
  if (!user || typeof user !== "object" || Array.isArray(user)) {
    return false;
  }
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) {
    return false;
  }
  if (!entitlement || typeof entitlement !== "object" || Array.isArray(entitlement)) {
    return false;
  }
  const userRecord = user as Record<string, unknown>;
  const workspaceRecord = workspace as Record<string, unknown>;
  const entitlementRecord = entitlement as Record<string, unknown>;
  return (
    typeof userRecord.id === "string" &&
    userRecord.id.length > 0 &&
    typeof userRecord.status === "string" &&
    typeof userRecord.display_email === "string" &&
    typeof workspaceRecord.id === "string" &&
    workspaceRecord.id.length > 0 &&
    typeof workspaceRecord.version === "number" &&
    typeof workspaceRecord.setup_completed === "boolean" &&
    typeof entitlementRecord.source === "string" &&
    typeof entitlementRecord.can_publish === "boolean" &&
    typeof record.first_sign_in === "boolean" &&
    typeof record.analytics_alias_id === "string"
  );
}

function readError(json: unknown, fallbackStatus: number): ApiError {
  const record = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const error =
    record.error && typeof record.error === "object" && !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : {};
  const meta =
    record.meta && typeof record.meta === "object" && !Array.isArray(record.meta)
      ? (record.meta as Record<string, unknown>)
      : {};
  return {
    status: fallbackStatus,
    code: typeof error.code === "string" && error.code.length > 0 ? error.code : "UNAVAILABLE",
    message: typeof error.message === "string" && error.message.length > 0 ? error.message : "Request failed.",
    retryable: error.retryable === true,
    ...(typeof meta.request_id === "string" ? { requestId: meta.request_id } : {}),
  };
}

export async function fetchOwnerMe(options: FetchOwnerMeOptions): Promise<OwnerMeResponse> {
  const timeoutMs = options.timeoutMs ?? OWNER_ME_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const startTimer = options.startTimer ?? defaultStartTimer;
  const controller = new AbortController();
  let timedOut = false;
  const clearTimer = startTimer(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${options.apiBaseUrl}/v1/me`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.accessToken}`,
        ...(options.clientRequestId ? { "x-client-request-id": options.clientRequestId } : {}),
      },
      signal: controller.signal,
    });
  } catch {
    return { ok: false, error: { ...NETWORK_UNAVAILABLE, network: timedOut ? "timeout" : "unreachable" } };
  } finally {
    clearTimer();
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    if (!response.ok) {
      return {
        ok: false,
        error: {
          status: response.status,
          code: "UNAVAILABLE",
          message: "Could not read the account response.",
          retryable: true,
        },
      };
    }
    return {
      ok: false,
      error: {
        status: response.status,
        code: "INVALID_RESPONSE",
        message: "Could not read the account response.",
        retryable: true,
      },
    };
  }
  if (!response.ok) {
    return { ok: false, error: readError(json, response.status) };
  }
  const data =
    json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>).data : undefined;
  if (!isUsableOwnerBootstrap(data)) {
    return {
      ok: false,
      error: {
        status: response.status,
        code: "INVALID_RESPONSE",
        message: "Could not read the account response.",
        retryable: true,
      },
    };
  }
  return { ok: true, data };
}

export async function fetchOwnerMeWithOneRefresh(options: {
  accessToken: string;
  fetchMe: (accessToken: string) => Promise<OwnerMeResponse>;
  refresh: () => Promise<string | undefined>;
}): Promise<FetchOwnerMeResult> {
  const first = await options.fetchMe(options.accessToken);
  if (first.ok || first.error.status !== 401) {
    return { ...first, refreshCount: 0 };
  }
  const nextToken = await options.refresh();
  if (!nextToken) {
    return { ...first, refreshCount: 1 };
  }
  const retry = await options.fetchMe(nextToken);
  return { ...retry, refreshCount: 1 };
}

export async function retryOwnerMe(options: {
  accessToken: string;
  fetchMe: (accessToken: string) => Promise<OwnerMeResponse>;
}): Promise<FetchOwnerMeResult> {
  const result = await options.fetchMe(options.accessToken);
  return { ...result, refreshCount: 0 };
}

export function classifyOwnerMeError(
  error: Pick<ApiError, "status" | "code"> & { network?: ApiError["network"] },
): BootstrapSupportCode {
  if (error.status === 0) {
    return error.network === "offline" ? "BOOTSTRAP_OFFLINE" : "BOOTSTRAP_NETWORK";
  }
  if (error.status === 401 && error.code === "AUTHENTICATION_FAILED") {
    return "BOOTSTRAP_SESSION";
  }
  if (error.status === 403 && error.code === "ACCOUNT_DELETING") {
    return "BOOTSTRAP_SESSION";
  }
  if (error.code === "DATABASE_TIMEOUT" || error.code === "DATABASE_UNAVAILABLE") {
    return "BOOTSTRAP_DATABASE";
  }
  if (error.status >= 500 && error.code !== "INVALID_RESPONSE") {
    return "BOOTSTRAP_SERVICE";
  }
  if (error.code === "INVALID_RESPONSE") {
    return "BOOTSTRAP_RESPONSE";
  }
  return "BOOTSTRAP_UNKNOWN";
}

/** A failure that a later identical GET /v1/me can plausibly succeed on. */
export function isTransientOwnerMeError(error: Pick<ApiError, "status">): boolean {
  return error.status === 0 || error.status >= 500;
}

export const TRANSIENT_SUPPORT_CODES: readonly BootstrapSupportCode[] = [
  "BOOTSTRAP_NETWORK",
  "BOOTSTRAP_OFFLINE",
  "BOOTSTRAP_SERVICE",
  "BOOTSTRAP_DATABASE",
];

/** In-flight retries after a fast transient failure, before any error screen is shown. */
export const BOOTSTRAP_RETRY_DELAYS_MS = [1_000, 3_000] as const;

/** Background retries while the app is foregrounded and bootstrap is still failing. */
export const BOOTSTRAP_BACKGROUND_RETRY_MS = [5_000, 15_000, 30_000, 60_000] as const;

export function backgroundBootstrapRetryDelay(attempt: number): number {
  const index = Math.min(Math.max(0, attempt), BOOTSTRAP_BACKGROUND_RETRY_MS.length - 1);
  return BOOTSTRAP_BACKGROUND_RETRY_MS[index] ?? 60_000;
}

export function shouldAutoRetryBootstrap(snapshot: Pick<AuthSnapshot, "status" | "supportCode">): boolean {
  if (snapshot.status === "offline_cached") {
    return true;
  }
  return (
    snapshot.status === "bootstrap_error" &&
    snapshot.supportCode !== undefined &&
    TRANSIENT_SUPPORT_CODES.includes(snapshot.supportCode)
  );
}

/**
 * What a stored-session read at launch means. supabase-js returns `session: null` with a retryable
 * fetch error when the access token expired and the refresh could not reach the auth server; the
 * stored refresh token is kept, so that is a network failure, not a sign-out.
 */
export function sessionReadOutcome(input: {
  hasSession: boolean;
  error?: unknown;
  isRetryableFetchError: (error: unknown) => boolean;
}): "session" | "network_failure" | "signed_out" {
  if (input.hasSession) {
    return "session";
  }
  if (input.error && input.isRetryableFetchError(input.error)) {
    return "network_failure";
  }
  return "signed_out";
}

export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries GET /v1/me after fast transient failures. A client timeout is not retried in-flight:
 * the user has already waited the full timeout, so the app moves to cached or error state and
 * retries in the background instead.
 */
export async function fetchOwnerMeWithTransientRetry(options: {
  attempt: () => Promise<FetchOwnerMeResult>;
  delaysMs?: readonly number[];
  sleep?: Sleep;
  shouldContinue?: () => boolean;
}): Promise<FetchOwnerMeResult & { attempts: number }> {
  const delays = options.delaysMs ?? BOOTSTRAP_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? realSleep;
  let result = await options.attempt();
  let attempts = 1;
  for (const delay of delays) {
    if (result.ok || !isTransientOwnerMeError(result.error) || result.error.network === "timeout") {
      break;
    }
    if (options.shouldContinue && !options.shouldContinue()) {
      break;
    }
    await sleep(delay);
    result = await options.attempt();
    attempts += 1;
  }
  return { ...result, attempts };
}

export function snapshotAfterBootstrapFailure(input: {
  supportCode: BootstrapSupportCode;
  emailDisplay?: string;
  lastAuthenticatedAt?: string;
  nowMs: number;
  hasCachedBootstrap: boolean;
}): AuthSnapshot {
  const sessionFailure = input.supportCode === "BOOTSTRAP_SESSION";
  if (
    !sessionFailure &&
    input.hasCachedBootstrap &&
    isOfflineReadPermitted(input.lastAuthenticatedAt, input.nowMs)
  ) {
    return {
      status: "offline_cached",
      emailDisplay: input.emailDisplay,
      lastAuthenticatedAt: input.lastAuthenticatedAt,
    };
  }
  if (
    sessionFailure &&
    input.lastAuthenticatedAt &&
    !isOfflineReadPermitted(input.lastAuthenticatedAt, input.nowMs)
  ) {
    return {
      status: "access_expired",
      emailDisplay: input.emailDisplay,
      lastAuthenticatedAt: input.lastAuthenticatedAt,
      supportCode: input.supportCode,
    };
  }
  return {
    status: "bootstrap_error",
    emailDisplay: input.emailDisplay,
    lastAuthenticatedAt: input.lastAuthenticatedAt,
    supportCode: input.supportCode,
  };
}

export function bootstrapErrorCopy(
  supportCode: BootstrapSupportCode,
):
  | "bootstrapSession"
  | "bootstrapApiUnreachable"
  | "bootstrapOffline"
  | "bootstrapService"
  | "bootstrapDatabase"
  | "bootstrapUnavailable" {
  switch (supportCode) {
    case "BOOTSTRAP_SESSION":
      return "bootstrapSession";
    case "BOOTSTRAP_NETWORK":
      return "bootstrapApiUnreachable";
    case "BOOTSTRAP_OFFLINE":
      return "bootstrapOffline";
    case "BOOTSTRAP_SERVICE":
      return "bootstrapService";
    case "BOOTSTRAP_DATABASE":
      return "bootstrapDatabase";
    default:
      return "bootstrapUnavailable";
  }
}

export function formatSupportCode(supportCode: BootstrapSupportCode): string {
  return `${copy.supportCodeLabel} ${supportCode}`;
}

export function bootstrapFailureScreenCopy(supportCode: BootstrapSupportCode): {
  message: string;
  supportLine: string;
} {
  return {
    message: copy[bootstrapErrorCopy(supportCode)],
    supportLine: formatSupportCode(supportCode),
  };
}
