import { parseOwnerEmail } from "./email.ts";

const SHA256_HEX = /^[0-9a-f]{64}$/;

export type FieldError = { field: string; message: string };

export type QuotePublishInput = {
  preview_hash: string;
  recipient_email: string;
  replace_pending_request_id?: string;
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
    if (key !== "preview_hash" && key !== "recipient_email" && key !== "replace_pending_request_id") {
      field_errors.push({ field: key, message: "Unknown fields are not allowed." });
    }
  }
  if (typeof record.preview_hash !== "string" || !SHA256_HEX.test(record.preview_hash)) {
    field_errors.push({ field: "preview_hash", message: "A 64-character preview hash is required." });
  }
  let recipient_email: string | undefined;
  if (typeof record.recipient_email !== "string") {
    field_errors.push({ field: "recipient_email", message: "A recipient email is required." });
  } else {
    const parsedEmail = parseOwnerEmail(record.recipient_email);
    if (!parsedEmail.ok) {
      field_errors.push({ field: "recipient_email", message: "Enter a valid email address." });
    } else {
      recipient_email = parsedEmail.display;
    }
  }
  let replace_pending_request_id: string | undefined;
  if (record.replace_pending_request_id !== undefined) {
    if (
      typeof record.replace_pending_request_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        record.replace_pending_request_id,
      )
    ) {
      field_errors.push({
        field: "replace_pending_request_id",
        message: "A request UUID is required to replace a pending quote.",
      });
    } else {
      replace_pending_request_id = record.replace_pending_request_id;
    }
  }
  if (field_errors.length > 0 || typeof record.preview_hash !== "string" || !recipient_email) {
    return { ok: false, field_errors };
  }
  return {
    ok: true,
    value: {
      preview_hash: record.preview_hash,
      recipient_email,
      ...(replace_pending_request_id ? { replace_pending_request_id } : {}),
    },
  };
}
