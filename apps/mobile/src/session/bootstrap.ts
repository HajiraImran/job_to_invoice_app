import { isOfflineReadPermitted, type AuthSnapshot } from "@job-to-invoice/schemas";
import type { ApiError, OwnerBootstrap } from "../api/client.ts";

export type OwnerMeOk = { ok: true; data: OwnerBootstrap };
export type OwnerMeFail = { ok: false; error: ApiError };
export type OwnerMeResponse = OwnerMeOk | OwnerMeFail;

export type FetchOwnerMeResult = OwnerMeResponse & { refreshCount: number };

export type BootstrapFailureKind = "session" | "unavailable" | "network";

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

export function classifyOwnerMeError(error: Pick<ApiError, "status" | "code">): BootstrapFailureKind {
  if (error.status === 0) {
    return "network";
  }
  if (error.status === 401) {
    return "session";
  }
  return "unavailable";
}

export function snapshotAfterBootstrapFailure(input: {
  kind: BootstrapFailureKind;
  emailDisplay?: string;
  lastAuthenticatedAt?: string;
  nowMs: number;
  hasCachedBootstrap: boolean;
}): AuthSnapshot {
  if (
    input.kind !== "session" &&
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
    input.kind === "session" &&
    input.lastAuthenticatedAt &&
    !isOfflineReadPermitted(input.lastAuthenticatedAt, input.nowMs)
  ) {
    return {
      status: "access_expired",
      emailDisplay: input.emailDisplay,
      lastAuthenticatedAt: input.lastAuthenticatedAt,
    };
  }
  return {
    status: "bootstrap_error",
    emailDisplay: input.emailDisplay,
    lastAuthenticatedAt: input.lastAuthenticatedAt,
  };
}

export function bootstrapErrorCopy(kind: BootstrapFailureKind): "bootstrapSession" | "networkError" | "bootstrapUnavailable" {
  if (kind === "session") {
    return "bootstrapSession";
  }
  if (kind === "network") {
    return "networkError";
  }
  return "bootstrapUnavailable";
}
