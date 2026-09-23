import { describe, expect, it, vi } from "vitest";
import { renderEmail01, renderEmail02, renderEmail03, renderEmail04, renderEmail05, renderEmail06, renderEmail07, renderEmail08, renderEmail09, renderEmail10, renderEmail11, reviewHref, sendResendEmail } from "./email.ts";

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

describe("EMAIL02 template", () => {
  it("renders previous, change, and new totals with a fragment review link", () => {
    const rendered = renderEmail02({
      appName: "Job to Invoice",
      businessName: "Quote Co",
      number: "CO-000001",
      revisionNo: 1,
      previousTotalCents: 25980,
      changeIncludingTaxCents: 10825,
      newAgreedTotalCents: 36805,
      href: "https://portal.example.test/review#tokenvalue",
    });
    expect(rendered.subject).toBe("Review a change to your job with Quote Co");
    expect(rendered.text).toContain("Previously agreed total: $259.80");
    expect(rendered.text).toContain("Change including tax: $108.25");
    expect(rendered.text).toContain("New agreed total: $368.05");
    expect(rendered.html).toContain("Review change");
    expect(rendered.html).toContain('href="https://portal.example.test/review#tokenvalue"');
    expect(rendered.html).not.toContain("?token=");
    expect(rendered.text).toContain("does not include a PDF");
  });
});

describe("EMAIL06 template", () => {
  it("renders view-invoice copy without tracking or approval language", () => {
    const rendered = renderEmail06({
      appName: "Job to Invoice",
      businessName: "Quote Co",
      number: "INV-000001",
      totalCents: 25980,
      dueDate: "2026-10-05",
      href: "https://portal.example.test/review#tokenvalue",
    });
    expect(rendered.subject).toBe("Invoice INV-000001 from Quote Co");
    expect(rendered.text).toContain("Issued total: $259.80");
    expect(rendered.text).toContain("Due date: October 5, 2026");
    expect(rendered.text).toContain("Payment instructions come from the business");
    expect(rendered.html).toContain("View invoice");
    expect(rendered.html).not.toContain("Approve");
    expect(rendered.html).not.toContain("tracking");
    expect(rendered.html).not.toContain("?token=");
  });
});

describe("EMAIL07 template", () => {
  it("renders view-credit copy that does not confirm a refund", () => {
    const rendered = renderEmail07({
      appName: "Job to Invoice",
      businessName: "Invoice Co",
      number: "CN-000001",
      invoiceNumber: "INV-000003",
      totalCents: 2165,
      href: "https://portal.example.test/review#tokenvalue",
    });
    expect(rendered.subject).toBe("Credit note CN-000001 from Invoice Co");
    expect(rendered.text).toContain("Credit total: $21.65");
    expect(rendered.text).toContain("Referenced invoice: INV-000003");
    expect(rendered.text).toContain("does not confirm a refund");
    expect(rendered.html).toContain("View credit");
    expect(rendered.html).not.toContain("Approve");
    expect(rendered.html).not.toContain("?token=");
  });
});

describe("EMAIL03 EMAIL04 EMAIL05 EMAIL08 templates", () => {
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

  it("renders EMAIL08 withdraw without a link and replace with a fragment href", () => {
    const withdrawn = renderEmail08({ appName: "Job to Invoice", number: "Q-000001", revisionNo: 1 });
    expect(withdrawn.subject).toBe("Update to document Q-000001");
    expect(withdrawn.text).toContain("no longer available");
    expect(withdrawn.html).not.toContain("/review#");
    const replaced = renderEmail08({
      appName: "Job to Invoice",
      number: "Q-000001",
      revisionNo: 1,
      href: "https://portal.example.test/review#newtoken",
    });
    expect(replaced.html).toContain("/review#newtoken");
    expect(replaced.html).not.toContain("?token=");
  });

  it("renders EMAIL09 with no automatic charge and remaining free slots", () => {
    const rendered = renderEmail09({
      appName: "Job to Invoice",
      endsOn: "September 24, 2026",
      remainingFreeSlots: 2,
    });
    expect(rendered.subject).toBe("Your trial ends on September 24, 2026");
    expect(rendered.text).toContain("No automatic charge.");
    expect(rendered.text).toContain("2 unused free published jobs");
    expect(rendered.html).not.toContain("@");
  });

  it("renders EMAIL10 without customer data or an attachment", () => {
    const rendered = renderEmail10({
      appName: "Job to Invoice",
      expiresAt: "2026-09-24T18:00:00.000Z",
    });
    expect(rendered.subject).toBe("Your business export is ready");
    expect(rendered.subject).not.toMatch(/@|INV-|customer/i);
    expect(rendered.text).toContain("does not include an export attachment");
    expect(rendered.html).not.toContain(".zip");
  });

  it("renders EMAIL11 with lock time, 30-day removal, and no cancel path", () => {
    const rendered = renderEmail11({
      appName: "Job to Invoice",
      lockedAt: "2026-09-23T12:00:00.000Z",
      completeBy: "2026-10-23T12:00:00.000Z",
      supportUrl: "https://support.example.test",
    });
    expect(rendered.subject).toBe("Your account deletion request");
    expect(rendered.text).toContain("Locked at 2026-09-23T12:00:00.000Z");
    expect(rendered.text).toContain("2026-10-23T12:00:00.000Z");
    expect(rendered.text).toContain("cannot be cancelled");
    expect(rendered.text).toContain("does not cancel an Apple subscription");
    expect(rendered.text).toContain("No invoices or customer records are kept by default");
    expect(rendered.html).toContain("https://support.example.test");
    expect(rendered.html).not.toContain("INV-");
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
