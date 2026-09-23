export const DELETION_CONFIRMATION = "DELETE";

export type DeletionParseOk = { ok: true; value: { confirmation: typeof DELETION_CONFIRMATION } };
export type DeletionParseFail = { ok: false; field_errors: { field: string; message: string }[] };

export function parseDeletionRequest(raw: unknown): DeletionParseOk | DeletionParseFail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, field_errors: [{ field: "body", message: "A JSON object is required." }] };
  }
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "confirmation")) {
    return { ok: false, field_errors: [{ field: "body", message: "Unknown fields are not allowed." }] };
  }
  if (body.confirmation !== DELETION_CONFIRMATION) {
    return {
      ok: false,
      field_errors: [{ field: "confirmation", message: "Type DELETE to confirm deletion." }],
    };
  }
  return { ok: true, value: { confirmation: DELETION_CONFIRMATION } };
}
