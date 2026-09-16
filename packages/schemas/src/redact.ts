const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const OTP = /\b\d{6}\b/g;
const REFRESH = /refresh[_-]?token["']?\s*[:=]\s*["']?[^"'\s]+/gi;

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "code",
  "otp",
  "token",
  "access_token",
  "refresh_token",
  "email",
  "password",
  "apikey",
  "phone",
  "contact_phone",
  "contact_email",
  "recipient_email",
  "token_hash",
  "ciphertext",
  "nonce",
  "href",
  "approval_url",
  "svix-signature",
  "svix-id",
  "svix-timestamp",
  "email_api_key",
  "email_webhook_secret",
  "business_name",
  "legal_name",
  "contact_name",
  "address",
  "address_json",
  "line1",
  "line2",
  "city",
  "postal_code",
  "zip",
]);

export function redactText(value: string): string {
  return value
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(JWT, "[REDACTED_JWT]")
    .replace(REFRESH, "refresh_token=[REDACTED]")
    .replace(EMAIL, "[REDACTED_EMAIL]")
    .replace(OTP, "[REDACTED_OTP]");
}

export function redactRecord(input: unknown): unknown {
  if (typeof input === "string") {
    return redactText(input);
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactRecord(item));
  }
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactRecord(value);
      }
    }
    return out;
  }
  return input;
}

export function analyticsPropertiesAreSafe(properties: Record<string, unknown>): boolean {
  for (const key of Object.keys(properties)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      return false;
    }
  }
  const serialized = JSON.stringify(properties);
  return redactText(serialized) === serialized;
}
