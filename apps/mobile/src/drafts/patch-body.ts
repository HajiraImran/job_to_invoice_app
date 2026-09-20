/**
 * Maps locally stored draft JSON to the owner PATCH /v1/drafts/{id} body.
 * Online save sends parseDraftPayload output only; outbox must match that contract.
 * Never forward QuoteDraftRecord envelope fields (id, job_id, version, totals, …).
 */

import {
  DRAFT_LINE_FIELDS,
  DRAFT_PAYLOAD_FIELDS,
  parseDraftPayload,
  type DraftPayloadInput,
} from "@job-to-invoice/schemas";

export type DraftPatchBodyResult =
  | { ok: true; value: DraftPayloadInput }
  | { ok: false; reason: "invalid_shape" | "validation_failed" };

function pickLineFields(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of DRAFT_LINE_FIELDS) {
    if (key in record) {
      picked[key] = record[key];
    }
  }
  return picked;
}

/**
 * Build the exact body used by the online quote PATCH fallback path.
 * Accepts either a clean DraftPayloadInput or a richer local QuoteDraftRecord snapshot.
 */
export function ownerDraftPatchBodyFromStored(payload: unknown): DraftPatchBodyResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "invalid_shape" };
  }
  const record = payload as Record<string, unknown>;
  const linesRaw = record.lines;
  if (!Array.isArray(linesRaw)) {
    return { ok: false, reason: "invalid_shape" };
  }
  const lines = linesRaw.map((line) => pickLineFields(line)).filter((line): line is Record<string, unknown> => line !== null);
  if (lines.length !== linesRaw.length) {
    return { ok: false, reason: "invalid_shape" };
  }

  const candidate: Record<string, unknown> = {};
  for (const key of DRAFT_PAYLOAD_FIELDS) {
    if (key === "lines") {
      candidate.lines = lines;
      continue;
    }
    if (key in record) {
      candidate[key] = record[key];
    }
  }

  const parsed = parseDraftPayload(candidate);
  if (!parsed.ok) {
    return { ok: false, reason: "validation_failed" };
  }
  return { ok: true, value: parsed.value };
}

/** True when a stored outbox body already matches the online PATCH contract (no unknown keys). */
export function isOwnerDraftPatchBody(payload: unknown): boolean {
  const mapped = ownerDraftPatchBodyFromStored(payload);
  if (!mapped.ok) {
    return false;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const keys = Object.keys(payload as object).sort();
  const allowed = [...DRAFT_PAYLOAD_FIELDS].sort();
  return keys.length === allowed.length && keys.every((key, index) => key === allowed[index]);
}
