import { describe, expect, it } from "vitest";
import {
  RESEND_WEBHOOK_FIXTURE,
  RESEND_WEBHOOK_MAX_BODY_BYTES,
  expectedWebhookSignature,
  parseUnixSeconds,
  parseWhsecKey,
  signedWebhookContent,
  timestampWithinTolerance,
  verifyResendWebhook,
} from "./resend-webhook.ts";

const NOW = 1_731_705_121;

function fixtureBody(): Buffer {
  return Buffer.from(RESEND_WEBHOOK_FIXTURE.rawPayload, "utf8");
}

describe("Resend webhook signature", () => {
  it("matches the official deterministic cryptographic fixture", () => {
    const key = parseWhsecKey(RESEND_WEBHOOK_FIXTURE.secret);
    expect(key).toBeDefined();
    if (!key) {
      return;
    }
    const content = signedWebhookContent(
      RESEND_WEBHOOK_FIXTURE.svixId,
      RESEND_WEBHOOK_FIXTURE.svixTimestamp,
      fixtureBody(),
    );
    const expected = expectedWebhookSignature(key, content).toString("base64");
    expect(`v1,${expected}`).toBe(RESEND_WEBHOOK_FIXTURE.svixSignature);
  });

  it("accepts the fixture when timestamp validation uses the fixture clock", () => {
    expect(
      verifyResendWebhook({
        secret: RESEND_WEBHOOK_FIXTURE.secret,
        svixId: RESEND_WEBHOOK_FIXTURE.svixId,
        svixTimestamp: RESEND_WEBHOOK_FIXTURE.svixTimestamp,
        svixSignature: RESEND_WEBHOOK_FIXTURE.svixSignature,
        rawBody: fixtureBody(),
        nowSec: NOW,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects an altered raw body", () => {
    expect(
      verifyResendWebhook({
        secret: RESEND_WEBHOOK_FIXTURE.secret,
        svixId: RESEND_WEBHOOK_FIXTURE.svixId,
        svixTimestamp: RESEND_WEBHOOK_FIXTURE.svixTimestamp,
        svixSignature: RESEND_WEBHOOK_FIXTURE.svixSignature,
        rawBody: Buffer.from('{"event_type":"ping","data":{"success":false}}', "utf8"),
        nowSec: NOW,
      }).ok,
    ).toBe(false);
  });

  it("rejects a parsed then re-serialized body", () => {
    const pretty = JSON.stringify(JSON.parse(RESEND_WEBHOOK_FIXTURE.rawPayload), null, 2);
    expect(pretty).not.toBe(RESEND_WEBHOOK_FIXTURE.rawPayload);
    expect(
      verifyResendWebhook({
        secret: RESEND_WEBHOOK_FIXTURE.secret,
        svixId: RESEND_WEBHOOK_FIXTURE.svixId,
        svixTimestamp: RESEND_WEBHOOK_FIXTURE.svixTimestamp,
        svixSignature: RESEND_WEBHOOK_FIXTURE.svixSignature,
        rawBody: Buffer.from(pretty, "utf8"),
        nowSec: NOW,
      }).ok,
    ).toBe(false);
  });

  it("rejects an altered svix-id", () => {
    expect(
      verifyResendWebhook({
        secret: RESEND_WEBHOOK_FIXTURE.secret,
        svixId: "msg_other",
        svixTimestamp: RESEND_WEBHOOK_FIXTURE.svixTimestamp,
        svixSignature: RESEND_WEBHOOK_FIXTURE.svixSignature,
        rawBody: fixtureBody(),
        nowSec: NOW,
      }).ok,
    ).toBe(false);
  });

  it("rejects a malformed timestamp", () => {
    expect(parseUnixSeconds("not-a-time")).toBeUndefined();
    expect(
      verifyResendWebhook({
        secret: RESEND_WEBHOOK_FIXTURE.secret,
        svixId: RESEND_WEBHOOK_FIXTURE.svixId,
        svixTimestamp: "1731705121.5",
        svixSignature: RESEND_WEBHOOK_FIXTURE.svixSignature,
        rawBody: fixtureBody(),
        nowSec: NOW,
      }).ok,
    ).toBe(false);
  });

  it("rejects a timestamp that is too old or too far in the future", () => {
    expect(timestampWithinTolerance(NOW - 301, NOW)).toBe(false);
    expect(timestampWithinTolerance(NOW + 301, NOW)).toBe(false);
    expect(timestampWithinTolerance(NOW - 300, NOW)).toBe(true);
    expect(
      verifyResendWebhook({
        secret: RESEND_WEBHOOK_FIXTURE.secret,
        svixId: RESEND_WEBHOOK_FIXTURE.svixId,
        svixTimestamp: RESEND_WEBHOOK_FIXTURE.svixTimestamp,
        svixSignature: RESEND_WEBHOOK_FIXTURE.svixSignature,
        rawBody: fixtureBody(),
        nowSec: NOW + 301,
      }).ok,
    ).toBe(false);
    expect(
      verifyResendWebhook({
        secret: RESEND_WEBHOOK_FIXTURE.secret,
        svixId: RESEND_WEBHOOK_FIXTURE.svixId,
        svixTimestamp: RESEND_WEBHOOK_FIXTURE.svixTimestamp,
        svixSignature: RESEND_WEBHOOK_FIXTURE.svixSignature,
        rawBody: fixtureBody(),
        nowSec: NOW - 301,
      }).ok,
    ).toBe(false);
  });

  it("accepts multiple signatures when one v1 signature is valid", () => {
    expect(
      verifyResendWebhook({
        secret: RESEND_WEBHOOK_FIXTURE.secret,
        svixId: RESEND_WEBHOOK_FIXTURE.svixId,
        svixTimestamp: RESEND_WEBHOOK_FIXTURE.svixTimestamp,
        svixSignature: `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${RESEND_WEBHOOK_FIXTURE.svixSignature}`,
        rawBody: fixtureBody(),
        nowSec: NOW,
      }).ok,
    ).toBe(true);
  });

  it("rejects when no valid v1 signature is present", () => {
    expect(
      verifyResendWebhook({
        secret: RESEND_WEBHOOK_FIXTURE.secret,
        svixId: RESEND_WEBHOOK_FIXTURE.svixId,
        svixTimestamp: RESEND_WEBHOOK_FIXTURE.svixTimestamp,
        svixSignature: "v2,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=",
        rawBody: fixtureBody(),
        nowSec: NOW,
      }).ok,
    ).toBe(false);
  });

  it("rejects invalid Base64 and wrong-length signatures", () => {
    expect(
      verifyResendWebhook({
        secret: RESEND_WEBHOOK_FIXTURE.secret,
        svixId: RESEND_WEBHOOK_FIXTURE.svixId,
        svixTimestamp: RESEND_WEBHOOK_FIXTURE.svixTimestamp,
        svixSignature: "v1,%%%not-base64%%%",
        rawBody: fixtureBody(),
        nowSec: NOW,
      }).ok,
    ).toBe(false);
    expect(
      verifyResendWebhook({
        secret: RESEND_WEBHOOK_FIXTURE.secret,
        svixId: RESEND_WEBHOOK_FIXTURE.svixId,
        svixTimestamp: RESEND_WEBHOOK_FIXTURE.svixTimestamp,
        svixSignature: "v1,YQ==",
        rawBody: fixtureBody(),
        nowSec: NOW,
      }).ok,
    ).toBe(false);
  });

  it("rejects missing required values and oversized bodies", () => {
    expect(
      verifyResendWebhook({
        secret: RESEND_WEBHOOK_FIXTURE.secret,
        svixId: "",
        svixTimestamp: RESEND_WEBHOOK_FIXTURE.svixTimestamp,
        svixSignature: RESEND_WEBHOOK_FIXTURE.svixSignature,
        rawBody: fixtureBody(),
        nowSec: NOW,
      }).ok,
    ).toBe(false);
    expect(
      verifyResendWebhook({
        secret: RESEND_WEBHOOK_FIXTURE.secret,
        svixId: RESEND_WEBHOOK_FIXTURE.svixId,
        svixTimestamp: RESEND_WEBHOOK_FIXTURE.svixTimestamp,
        svixSignature: RESEND_WEBHOOK_FIXTURE.svixSignature,
        rawBody: Buffer.alloc(RESEND_WEBHOOK_MAX_BODY_BYTES + 1, 97),
        nowSec: NOW,
      }).ok,
    ).toBe(false);
  });

  it("does not treat a missing whsec_ prefix as valid", () => {
    expect(parseWhsecKey("not-a-whsec")).toBeUndefined();
  });

  it("enforces signature verification in development", () => {
    expect(
      verifyResendWebhook({
        secret: RESEND_WEBHOOK_FIXTURE.secret,
        svixId: RESEND_WEBHOOK_FIXTURE.svixId,
        svixTimestamp: RESEND_WEBHOOK_FIXTURE.svixTimestamp,
        svixSignature: "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        rawBody: fixtureBody(),
        nowSec: NOW,
      }).ok,
    ).toBe(false);
  });
});
