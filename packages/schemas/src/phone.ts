const E164 = /^\+[1-9]\d{7,14}$/;

export type PhoneParseResult = { ok: true; value: string | null } | { ok: false; code: "invalid" };

export function parseOptionalPhone(input: unknown): PhoneParseResult {
  if (input === undefined || input === null) {
    return { ok: true, value: null };
  }
  if (typeof input !== "string") {
    return { ok: false, code: "invalid" };
  }
  const value = input.trim();
  if (value.length === 0) {
    return { ok: true, value: null };
  }
  if (!E164.test(value)) {
    return { ok: false, code: "invalid" };
  }
  return { ok: true, value };
}
