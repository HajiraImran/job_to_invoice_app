import type { ApiError } from "../api/client.ts";
import { grantRequiresFreshAuth } from "../quotes/pending-replace.ts";

export type OwnerMutator = <T>(options: {
  path: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}) => Promise<{ ok: true; data: T } | { ok: false; error: ApiError }>;

export type ExportGrantResult =
  | { ok: true; grant: string }
  | { ok: false; stepUp: true }
  | { ok: false; stepUp: false; error: ApiError };

export async function issueExportGrant(run: OwnerMutator): Promise<ExportGrantResult> {
  const result = await run<{ grant: string; action?: string }>({
    path: "/v1/account/action-grants",
    method: "POST",
    body: { action: "export" },
  });
  if (result.ok && typeof result.data.grant === "string" && result.data.grant.length > 0) {
    return { ok: true, grant: result.data.grant };
  }
  if (!result.ok && grantRequiresFreshAuth(result.error)) {
    return { ok: false, stepUp: true };
  }
  return {
    ok: false,
    stepUp: false,
    error: result.ok
      ? { status: 500, code: "UNAVAILABLE", message: "Request failed.", retryable: true }
      : result.error,
  };
}

export async function submitExportRequest(
  run: OwnerMutator,
  input: { grant: string; idempotencyKey: string; newer?: boolean },
): Promise<{ ok: true; id: string } | { ok: false; error: ApiError }> {
  const result = await run<{ id: string }>({
    path: "/v1/exports",
    method: "POST",
    body: input.newer ? { newer: true } : {},
    idempotencyKey: input.idempotencyKey,
    headers: { "X-Action-Grant": input.grant },
  });
  if (result.ok && typeof result.data.id === "string") {
    return { ok: true, id: result.data.id };
  }
  return {
    ok: false,
    error: result.ok
      ? { status: 500, code: "UNAVAILABLE", message: "Request failed.", retryable: true }
      : result.error,
  };
}
