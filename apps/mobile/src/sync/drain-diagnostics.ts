/**
 * Development-only structured diagnostics for outbox drain.
 * Safe fields only: stage, kind, outcome, HTTP status. No IDs, tokens, bodies, or paths.
 */

export type DrainDiagStage =
  | "prepare"
  | "select"
  | "request"
  | "ack"
  | "retry"
  | "conflict"
  | "complete";

export type DrainDiagOutcome =
  | "empty"
  | "drained"
  | "offline"
  | "no_authenticated_session"
  | "ineligible_retry_time"
  | "no_executable_operation"
  | "request_failure"
  | "auth_refresh_failure"
  | "conflict"
  | "server_failure"
  | "local_ack_failure"
  | "forced_immediate"
  | "validation_failure";

export type DrainDiagnosticEvent = {
  stage: DrainDiagStage;
  outcome: DrainDiagOutcome;
  operationKind?: "draft" | "job";
  httpStatus?: number;
  drained?: number;
  remaining?: number;
};

export function emitDrainDiagnostic(event: DrainDiagnosticEvent): void {
  if (typeof __DEV__ === "undefined" || !__DEV__) {
    return;
  }
  console.info("[sync.drain]", JSON.stringify(event));
}

export function drainDiagnosticIsSafe(
  event: Record<string, unknown>,
  forbiddenFragments: readonly string[],
): boolean {
  const allowed = new Set([
    "stage",
    "outcome",
    "operationKind",
    "httpStatus",
    "drained",
    "remaining",
  ]);
  for (const key of Object.keys(event)) {
    if (!allowed.has(key)) {
      return false;
    }
  }
  const serialized = JSON.stringify(event);
  return !forbiddenFragments.some((fragment) => fragment.length > 0 && serialized.includes(fragment));
}
