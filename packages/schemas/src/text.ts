export function hasDisallowedControl(value: string, options?: { allowNewlines?: boolean }): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    if (code === 127) {
      return true;
    }
    if (code >= 32) {
      continue;
    }
    if (options?.allowNewlines && (code === 10 || code === 13)) {
      continue;
    }
    return true;
  }
  return false;
}

export type BoundedTextResult =
  | { ok: true; value: string }
  | { ok: false; code: "required" | "too_short" | "too_long" | "invalid" };

export function parseBoundedText(
  input: unknown,
  options: { min: number; max: number; multiline?: boolean },
): BoundedTextResult {
  if (typeof input !== "string") {
    return { ok: false, code: "invalid" };
  }
  const value = input.trim();
  if (value.length === 0) {
    return { ok: false, code: "required" };
  }
  if (hasDisallowedControl(value, { allowNewlines: options.multiline === true })) {
    return { ok: false, code: "invalid" };
  }
  if (value.length < options.min) {
    return { ok: false, code: "too_short" };
  }
  if (value.length > options.max) {
    return { ok: false, code: "too_long" };
  }
  return { ok: true, value };
}

export function parseOptionalBoundedText(
  input: unknown,
  options: { min: number; max: number; multiline?: boolean },
): { ok: true; value: string | null } | { ok: false; code: "too_short" | "too_long" | "invalid" } {
  if (input === undefined || input === null) {
    return { ok: true, value: null };
  }
  if (typeof input !== "string") {
    return { ok: false, code: "invalid" };
  }
  if (input.trim().length === 0) {
    return { ok: true, value: null };
  }
  const parsed = parseBoundedText(input, options);
  if (!parsed.ok) {
    return { ok: false, code: parsed.code === "required" ? "invalid" : parsed.code };
  }
  return parsed;
}
