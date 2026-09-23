import { parseBoundedText } from "./text.ts";

export const SUPPORT_CATEGORIES = ["account", "billing", "documents", "access", "other"] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const SUPPORT_MESSAGE_MIN = 10;
export const SUPPORT_MESSAGE_MAX = 2000;
export const SUPPORT_CONTENT_GRANT_HOURS = 24;

const CATEGORY_SET = new Set<string>(SUPPORT_CATEGORIES);

export function isSupportCategory(value: string): value is SupportCategory {
  return CATEGORY_SET.has(value);
}

export type SupportCaseParseOk = {
  ok: true;
  value: {
    category: SupportCategory;
    message: string;
    grant_content_access: boolean;
  };
};
export type SupportCaseParseFail = { ok: false; field_errors: { field: string; message: string }[] };

export function parseSupportCase(raw: unknown): SupportCaseParseOk | SupportCaseParseFail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, field_errors: [{ field: "body", message: "A JSON object is required." }] };
  }
  const body = raw as Record<string, unknown>;
  const unknown = Object.keys(body).filter(
    (key) => key !== "category" && key !== "message" && key !== "grant_content_access",
  );
  if (unknown.length > 0) {
    return { ok: false, field_errors: [{ field: "body", message: "Unknown fields are not allowed." }] };
  }
  const errors: { field: string; message: string }[] = [];
  if (typeof body.category !== "string" || !isSupportCategory(body.category)) {
    errors.push({ field: "category", message: "Choose a support category." });
  }
  const message = parseBoundedText(body.message, {
    min: SUPPORT_MESSAGE_MIN,
    max: SUPPORT_MESSAGE_MAX,
    multiline: true,
  });
  if (!message.ok) {
    errors.push({
      field: "message",
      message:
        message.code === "too_short"
          ? `Describe the problem in at least ${SUPPORT_MESSAGE_MIN} characters.`
          : message.code === "too_long"
            ? `Keep the message under ${SUPPORT_MESSAGE_MAX} characters.`
            : "Enter a plain-text message.",
    });
  }
  if (body.grant_content_access !== undefined && typeof body.grant_content_access !== "boolean") {
    errors.push({ field: "grant_content_access", message: "grant_content_access must be true or false." });
  }
  if (errors.length > 0 || !message.ok || typeof body.category !== "string" || !isSupportCategory(body.category)) {
    return { ok: false, field_errors: errors };
  }
  return {
    ok: true,
    value: {
      category: body.category,
      message: message.value,
      grant_content_access: body.grant_content_access === true,
    },
  };
}

export function publicSupportUrl(value: string | undefined | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  if (!/^https:\/\//i.test(trimmed) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}
