export const ACTION_GRANT_ACTIONS = ["export", "deletion", "email_change", "replace_link"] as const;
export type ActionGrantAction = (typeof ACTION_GRANT_ACTIONS)[number];

export const ACTION_GRANT_FRESH_AUTH_SECONDS = 300;
export const ACTION_GRANT_TTL_SECONDS = 300;

export type ParseOk<T> = { ok: true; value: T };
export type ParseFail = { ok: false; field_errors: { field: string; message: string }[] };

export function parseActionGrantBody(raw: unknown): ParseOk<{ action: ActionGrantAction }> | ParseFail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, field_errors: [{ field: "body", message: "A JSON object is required." }] };
  }
  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "action")) {
    return { ok: false, field_errors: [{ field: "body", message: "Unknown fields are not allowed." }] };
  }
  if (typeof body.action !== "string" || !(ACTION_GRANT_ACTIONS as readonly string[]).includes(body.action)) {
    return { ok: false, field_errors: [{ field: "action", message: "A supported action is required." }] };
  }
  return { ok: true, value: { action: body.action as ActionGrantAction } };
}

export function parseWithdrawBody(raw: unknown): ParseOk<{ reason: string }> | ParseFail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, field_errors: [{ field: "body", message: "A JSON object is required." }] };
  }
  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "reason")) {
    return { ok: false, field_errors: [{ field: "body", message: "Unknown fields are not allowed." }] };
  }
  if (typeof body.reason !== "string") {
    return { ok: false, field_errors: [{ field: "reason", message: "A reason is required." }] };
  }
  const reason = body.reason.trim();
  if (reason.length < 1 || reason.length > 500) {
    return { ok: false, field_errors: [{ field: "reason", message: "Reason must be 1 to 500 characters." }] };
  }
  return { ok: true, value: { reason } };
}

export function parseEmptyObjectBody(raw: unknown): ParseOk<Record<string, never>> | ParseFail {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: {} };
  }
  if (typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw as object).length > 0) {
    return { ok: false, field_errors: [{ field: "body", message: "Unknown fields are not allowed." }] };
  }
  return { ok: true, value: {} };
}
