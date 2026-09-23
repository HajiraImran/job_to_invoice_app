/**
 * Outbox eligibility rules (SYNC05).
 * Never queue publish, approval, invoice, payment, ledger, purchase, export, or deletion commands.
 */

const FORBIDDEN_PATH_PATTERNS: RegExp[] = [
  /\/publish\b/i,
  /\/approve\b/i,
  /\/approval/i,
  /\/invoice/i,
  /\/payment/i,
  /\/refund/i,
  /\/ledger/i,
  /\/purchase/i,
  /\/entitlement/i,
  /\/deletion/i,
  /\/delete\b/i,
  /\/credit/i,
  /\/cancel\b/i,
  /\/archive\b/i,
  /\/finish\b/i,
  /\/subscription\b/i,
  /\/trial\b/i,
  /\/exports?\b/i,
];

export const ALLOWED_OUTBOX_METHODS = ["POST", "PATCH"] as const;
export type AllowedOutboxMethod = (typeof ALLOWED_OUTBOX_METHODS)[number];

export type OutboxResourceKind = "job" | "draft";

export function isForbiddenOutboxPath(path: string): boolean {
  return FORBIDDEN_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

export function assertOutboxOperationAllowed(input: {
  method: string;
  path: string;
  resourceKind: string;
}): void {
  const method = input.method.toUpperCase();
  if (method !== "POST" && method !== "PATCH") {
    throw new Error("OUTBOX_FORBIDDEN");
  }
  if (isForbiddenOutboxPath(input.path)) {
    throw new Error("OUTBOX_FORBIDDEN");
  }
  if (input.resourceKind !== "job" && input.resourceKind !== "draft") {
    throw new Error("OUTBOX_FORBIDDEN");
  }
  // Draft create-open is POST /v1/jobs/:id/quote — allowed.
  // Draft PATCH /v1/drafts/:id — allowed.
  // Job create POST /v1/jobs — allowed.
  if (method === "POST" && input.resourceKind === "draft" && !/\/jobs\/[^/]+\/quote$/i.test(input.path)) {
    throw new Error("OUTBOX_FORBIDDEN");
  }
  if (method === "PATCH" && input.resourceKind === "draft" && !/\/drafts\/[^/]+$/i.test(input.path)) {
    throw new Error("OUTBOX_FORBIDDEN");
  }
  if (method === "POST" && input.resourceKind === "job" && !/^\/v1\/jobs$/i.test(input.path)) {
    throw new Error("OUTBOX_FORBIDDEN");
  }
}
