import { describe, expect, it, vi } from "vitest";
import { renderEmail01, renderEmail03, renderEmail04, renderEmail05, reviewHref, sendResendEmail } from "./email.ts";

describe("EMAIL01 template", () => {
  it("renders a fragment href without a token query parameter or PDF attachment", () => {
    const href = reviewHref("https://portal.example.test/", "tokenvalue");
    expect(href).toBe("https://portal.example.test/review#tokenvalue");
    expect(href).not.toContain("?token=");
    const rendered = renderEmail01({
      appName: "Job to Invoice",
      businessName: "Quote Co",
      number: "Q-000001",
      revisionNo: 1,
      href,
    });
    expect(rendered.subject).toBe("Review quote Q-000001 from Quote Co");
    expect(rendered.html).toContain('href="https://portal.example.test/review#tokenvalue"');
    expect(rendered.html).toContain("Review quote");
    expect(rendered.text).toContain("does not include a PDF");
    expect(rendered.html.toLowerCase()).not.toContain("attachment");
    expect(rendered.html).not.toContain("?token=");
  });
});

describe("EMAIL03 EMAIL04 EMAIL05 templates", () => {
  it("keeps the verification code free of quote totals and does not mint a second token", () => {
    const code = renderEmail03({ appName: "Job to Invoice", code: "123456" });
    expect(code.subject).toBe("Job to Invoice verification code");
    expect(code.text).toContain("123456");
    expect(code.text).toContain("ten minutes");
    expect(code.text.toLowerCase()).not.toContain("quote");
    expect(code.html).not.toMatch(/\$|25980|Q-000001|total/i);
    const receipt = renderEmail04({
      appName: "Job to Invoice",
      businessName: "Quote Co",
      number: "Q-000001",
      revisionNo: 1,
      decision: "approve",
    });
    expect(receipt.subject).toBe("Quote Q-000001 accepted");
    expect(receipt.text).toContain("does not collect payment");
    const owner = renderEmail05({
      appName: "Job to Invoice",
      number: "Q-000001",
      revisionNo: 1,
      decision: "decline",
    });
    expect(owner.subject).toBe("Quote Q-000001 was declined");
    expect(owner.html).not.toContain("/review#");
  });
});

describe("Resend send", () => {
  it("posts with the effect_key Idempotency-Key and treats timeout/429/5xx as retryable", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(_url).toBe("https://api.resend.com/emails");
      const headers = new Headers(init?.headers);
      expect(headers.get("Idempotency-Key")).toBe("effect-1");
      expect(headers.get("Authorization")).toMatch(/^Bearer /);
      const body = JSON.parse(String(init?.body)) as { html?: string; text?: string; to?: string[] };
      expect(body.to).toEqual(["customer@example.com"]);
      expect(body.html).not.toContain("tokenvalue");
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
    });
    const ok = await sendResendEmail({
      apiKey: "email-key-material-ok",
      idempotencyKey: "effect-1",
      from: "Job to Invoice <quotes@mail.test>",
      to: "customer@example.com",
      subject: "Review quote Q-000001 from Quote Co",
      html: "<p>Review quote</p>",
      text: "Review quote",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(ok).toEqual({ ok: true, id: "msg_1" });

    const retry429 = await sendResendEmail({
      apiKey: "email-key-material-ok",
      idempotencyKey: "effect-1",
      from: "Job to Invoice <quotes@mail.test>",
      to: "customer@example.com",
      subject: "s",
      html: "h",
      text: "t",
      fetchImpl: (async () => new Response("no", { status: 429 })) as unknown as typeof fetch,
    });
    expect(retry429).toEqual({ ok: false, retryable: true, status: 429 });

    const perm = await sendResendEmail({
      apiKey: "email-key-material-ok",
      idempotencyKey: "effect-1",
      from: "Job to Invoice <quotes@mail.test>",
      to: "customer@example.com",
      subject: "s",
      html: "h",
      text: "t",
      fetchImpl: (async () => new Response("no", { status: 422 })) as unknown as typeof fetch,
    });
    expect(perm).toEqual({ ok: false, retryable: false, status: 422 });
  });
});
