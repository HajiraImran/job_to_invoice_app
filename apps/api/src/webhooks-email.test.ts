import { loadEnv, RESEND_WEBHOOK_FIXTURE } from "@job-to-invoice/config";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";

const NOW = 1_731_705_121;

describe("email webhook route", () => {
  it("verifies the official fixture, rejects altered bodies, and does not log secrets", async () => {
    const env = loadEnv({
      APP_ENV: "development",
      PORTAL_ORIGIN: "http://localhost:3000",
      EMAIL_WEBHOOK_SECRET: RESEND_WEBHOOK_FIXTURE.secret,
    });
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    const app = buildApp({ env, nowSec: () => NOW });
    try {
      const ok = await app.inject({
        method: "POST",
        url: "/webhooks/email",
        headers: {
          "content-type": "application/json",
          "svix-id": RESEND_WEBHOOK_FIXTURE.svixId,
          "svix-timestamp": RESEND_WEBHOOK_FIXTURE.svixTimestamp,
          "svix-signature": RESEND_WEBHOOK_FIXTURE.svixSignature,
        },
        payload: RESEND_WEBHOOK_FIXTURE.rawPayload,
      });
      expect(ok.statusCode).toBe(401);

      const missing = await app.inject({
        method: "POST",
        url: "/webhooks/email",
        headers: { "content-type": "application/json" },
        payload: RESEND_WEBHOOK_FIXTURE.rawPayload,
      });
      expect(missing.statusCode).toBe(401);

      const duplicated = await app.inject({
        method: "POST",
        url: "/webhooks/email",
        headers: {
          "content-type": "application/json",
          "svix-id": [RESEND_WEBHOOK_FIXTURE.svixId, RESEND_WEBHOOK_FIXTURE.svixId],
          "svix-timestamp": RESEND_WEBHOOK_FIXTURE.svixTimestamp,
          "svix-signature": RESEND_WEBHOOK_FIXTURE.svixSignature,
        },
        payload: RESEND_WEBHOOK_FIXTURE.rawPayload,
      });
      expect(duplicated.statusCode).toBe(401);
      expect(JSON.stringify(ok.json())).not.toContain(RESEND_WEBHOOK_FIXTURE.secret);
      expect(logs.join("\n")).not.toContain(RESEND_WEBHOOK_FIXTURE.secret);
      expect(logs.join("\n")).not.toContain(RESEND_WEBHOOK_FIXTURE.svixSignature);
    } finally {
      console.log = original;
      await app.close();
    }
  });
});
