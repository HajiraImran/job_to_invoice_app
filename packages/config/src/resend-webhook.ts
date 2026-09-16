import { createHmac, timingSafeEqual } from "node:crypto";

export const RESEND_WEBHOOK_TOLERANCE_SEC = 300;
export const RESEND_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
export const WHSEC_PREFIX = "whsec_";

export const RESEND_WEBHOOK_HEADERS = ["svix-id", "svix-timestamp", "svix-signature"] as const;

export type ResendWebhookVerifyInput = {
  secret: string;
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
  rawBody: Buffer;
  nowSec?: number;
};

export type ResendWebhookVerifyResult =
  | { ok: true }
  | { ok: false; code: "invalid" };

function fail(): ResendWebhookVerifyResult {
  return { ok: false, code: "invalid" };
}

export function parseWhsecKey(secret: string): Buffer | undefined {
  if (!secret.startsWith(WHSEC_PREFIX) || secret.length <= WHSEC_PREFIX.length) {
    return undefined;
  }
  const encoded = secret.slice(WHSEC_PREFIX.length);
  try {
    const key = Buffer.from(encoded, "base64");
    if (key.length < 16) {
      return undefined;
    }
    return key;
  } catch {
    return undefined;
  }
}

export function parseUnixSeconds(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

export function timestampWithinTolerance(timestampSec: number, nowSec: number, toleranceSec = RESEND_WEBHOOK_TOLERANCE_SEC): boolean {
  return Math.abs(nowSec - timestampSec) <= toleranceSec;
}

function parseV1Signatures(header: string): Buffer[] {
  const out: Buffer[] = [];
  for (const part of header.trim().split(/\s+/)) {
    if (!part.startsWith("v1,")) {
      continue;
    }
    const encoded = part.slice(3);
    if (!encoded) {
      continue;
    }
    try {
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.length > 0) {
        out.push(decoded);
      }
    } catch {
      continue;
    }
  }
  return out;
}

export function signedWebhookContent(svixId: string, svixTimestamp: string, rawBody: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${svixId}.${svixTimestamp}.`, "utf8"), rawBody]);
}

export function expectedWebhookSignature(key: Buffer, content: Buffer): Buffer {
  return createHmac("sha256", key).update(content).digest();
}

function signatureMatches(expected: Buffer, candidates: Buffer[]): boolean {
  let matched = false;
  for (const candidate of candidates) {
    if (candidate.length !== expected.length) {
      continue;
    }
    if (timingSafeEqual(candidate, expected)) {
      matched = true;
    }
  }
  return matched;
}

export function verifyResendWebhook(input: ResendWebhookVerifyInput): ResendWebhookVerifyResult {
  if (input.rawBody.byteLength === 0 || input.rawBody.byteLength > RESEND_WEBHOOK_MAX_BODY_BYTES) {
    return fail();
  }
  if (!input.svixId || !input.svixTimestamp || !input.svixSignature) {
    return fail();
  }
  const timestamp = parseUnixSeconds(input.svixTimestamp);
  if (timestamp === undefined) {
    return fail();
  }
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (!timestampWithinTolerance(timestamp, nowSec)) {
    return fail();
  }
  const key = parseWhsecKey(input.secret);
  if (!key) {
    return fail();
  }
  const candidates = parseV1Signatures(input.svixSignature);
  if (candidates.length === 0) {
    return fail();
  }
  const expected = expectedWebhookSignature(key, signedWebhookContent(input.svixId, input.svixTimestamp, input.rawBody));
  if (!signatureMatches(expected, candidates)) {
    return fail();
  }
  return { ok: true };
}

export const RESEND_WEBHOOK_FIXTURE = {
  secret: "whsec_plJ3nmyCDGBKInavdOK15jsl",
  rawPayload: '{"event_type":"ping","data":{"success":true}}',
  svixId: "msg_loFOjxBNrRLzqYUf",
  svixTimestamp: "1731705121",
  svixSignature: "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=",
} as const;
