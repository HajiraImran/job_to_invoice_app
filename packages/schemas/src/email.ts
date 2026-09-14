export const EMAIL_MAX_LENGTH = 254;

function hasDisallowedControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    if (code === 127 || (code < 32 && code !== 9)) {
      return true;
    }
  }
  return false;
}

export type EmailParseResult =
  | { ok: true; display: string; normalized: string }
  | { ok: false; code: "invalid" | "too_long" };

export function parseOwnerEmail(input: string): EmailParseResult {
  const display = input.trim();
  if (display.length === 0) {
    return { ok: false, code: "invalid" };
  }
  if (display.length > EMAIL_MAX_LENGTH) {
    return { ok: false, code: "too_long" };
  }
  if (hasDisallowedControl(display)) {
    return { ok: false, code: "invalid" };
  }
  const at = display.lastIndexOf("@");
  if (at <= 0 || at === display.length - 1) {
    return { ok: false, code: "invalid" };
  }
  const local = display.slice(0, at);
  const domain = display.slice(at + 1);
  if (local.includes(" ") || domain.includes(" ") || !domain.includes(".")) {
    return { ok: false, code: "invalid" };
  }
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) {
    return { ok: false, code: "invalid" };
  }
  return {
    ok: true,
    display,
    normalized: display.toLowerCase(),
  };
}

export function maskEmail(display: string): string {
  const at = display.lastIndexOf("@");
  if (at <= 0) {
    return "***";
  }
  const local = display.slice(0, at);
  const domain = display.slice(at + 1);
  const visible = local.slice(0, 1);
  return `${visible}***@${domain}`;
}
