const SHA256_HEX = /^[0-9a-f]{64}$/;

export type FieldError = { field: string; message: string };

export type QuotePublishInput = {
  preview_hash: string;
};

export type QuotePublishParseResult =
  | { ok: true; value: QuotePublishInput }
  | { ok: false; field_errors: FieldError[] };

export function parseQuotePublish(input: unknown): QuotePublishParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field_errors: [{ field: "body", message: "Invalid request." }] };
  }
  const record = input as Record<string, unknown>;
  const field_errors: FieldError[] = [];
  for (const key of Object.keys(record)) {
    if (key !== "preview_hash") {
      field_errors.push({ field: key, message: "Unknown fields are not allowed." });
    }
  }
  if (typeof record.preview_hash !== "string" || !SHA256_HEX.test(record.preview_hash)) {
    field_errors.push({ field: "preview_hash", message: "A 64-character preview hash is required." });
  }
  if (field_errors.length > 0 || typeof record.preview_hash !== "string") {
    return { ok: false, field_errors };
  }
  return { ok: true, value: { preview_hash: record.preview_hash } };
}
