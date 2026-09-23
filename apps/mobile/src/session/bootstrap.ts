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
  return {
    status: fallbackStatus,
    code: typeof error.code === "string" && error.code.length > 0 ? error.code : "UNAVAILABLE",
    message: typeof error.message === "string" && error.message.length > 0 ? error.message : "Request failed.",
    retryable: error.retryable === true,
  };
}

export async function fetchOwnerMe(options: FetchOwnerMeOptions): Promise<OwnerMeResponse> {
  const timeoutMs = options.timeoutMs ?? OWNER_ME_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const startTimer = options.startTimer ?? defaultStartTimer;
  const controller = new AbortController();
  const clearTimer = startTimer(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${options.apiBaseUrl}/v1/me`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.accessToken}`,
      },
      signal: controller.signal,
    });
  } catch {
    return { ok: false, error: { ...NETWORK_UNAVAILABLE } };
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

export function classifyOwnerMeError(error: Pick<ApiError, "status" | "code">): BootstrapSupportCode {
  if (error.status === 0) {
    return "BOOTSTRAP_NETWORK";
  }
  if (error.status === 401 && error.code === "AUTHENTICATION_FAILED") {
    return "BOOTSTRAP_SESSION";
  }
  if (error.status === 403 && error.code === "ACCOUNT_DELETING") {
    return "BOOTSTRAP_SESSION";
  }
  if (error.status === 503 && error.code === "UNAVAILABLE") {
    return "BOOTSTRAP_SERVICE";
  }
  if (error.code === "INVALID_RESPONSE") {
    return "BOOTSTRAP_RESPONSE";
  }
  return "BOOTSTRAP_UNKNOWN";
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
): "bootstrapSession" | "networkError" | "bootstrapUnavailable" {
  if (supportCode === "BOOTSTRAP_SESSION") {
    return "bootstrapSession";
  }
  if (supportCode === "BOOTSTRAP_NETWORK") {
    return "networkError";
  }
  return "bootstrapUnavailable";
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
