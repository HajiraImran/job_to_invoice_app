import {
  decryptDeliveryToken,
  decryptUtf8,
  encodeFragmentToken,
  parseVersionedSecret,
  type VersionedSecret,
} from "@job-to-invoice/config";
import type { Pool } from "pg";
import { withWorkerRole, WORKER_CLAIM_TIMEOUT_MS, WORKER_STATEMENT_TIMEOUT_MS } from "./db.ts";
import { whileLeased } from "./outbox.ts";

export const RESEND_EMAILS_URL = "https://api.resend.com/emails";

export type Email01Input = {
  appName: string;
  businessName: string;
  number: string;
  revisionNo: number;
  href: string;
};

export function renderEmail01(input: Email01Input): { subject: string; text: string; html: string } {
  const subject = `Review quote ${input.number} from ${input.businessName}`;
  const text = [
    `${input.appName}`,
    `${input.businessName} sent quote ${input.number} R${input.revisionNo} for your review.`,
    "Open the review link, then request a verification code at the bound email address.",
    "This message does not include a PDF attachment.",
    `Review quote: ${input.href}`,
  ].join("\n");
  const html = `<!doctype html><html lang="en"><body>
<p>${escapeHtml(input.appName)}</p>
<p>${escapeHtml(input.businessName)} sent quote ${escapeHtml(input.number)} R${input.revisionNo} for your review.</p>
<p>Open the review link, then request a verification code at the bound email address. This message does not include a PDF.</p>
<p><a href="${escapeAttribute(input.href)}">Review quote</a></p>
</body></html>`;
  return { subject, text, html };
}

export function renderEmail03(input: { appName: string; code: string }): { subject: string; text: string; html: string } {
  const subject = `${input.appName} verification code`;
  const text = [
    input.appName,
    `Your verification code is ${input.code}.`,
    "It expires in ten minutes.",
    "If you did not request this code, ignore this message.",
  ].join("\n");
  const html = `<!doctype html><html lang="en"><body>
<p>${escapeHtml(input.appName)}</p>
<p>Your verification code is ${escapeHtml(input.code)}. It expires in ten minutes.</p>
<p>If you did not request this code, ignore this message.</p>
</body></html>`;
  return { subject, text, html };
}

export function renderEmail04(input: {
  appName: string;
  businessName: string;
  number: string;
  revisionNo: number;
  decision: string;
}): { subject: string; text: string; html: string } {
  const action = input.decision === "approve" ? "accepted" : "declined";
  const subject = `Quote ${input.number} ${action}`;
  const text = [
    input.appName,
    `You ${action} quote ${input.number} R${input.revisionNo} from ${input.businessName}.`,
    "This message does not collect payment.",
  ].join("\n");
  const html = `<!doctype html><html lang="en"><body>
<p>${escapeHtml(input.appName)}</p>
<p>You ${escapeHtml(action)} quote ${escapeHtml(input.number)} R${input.revisionNo} from ${escapeHtml(input.businessName)}.</p>
<p>This message does not collect payment.</p>
</body></html>`;
  return { subject, text, html };
}

export function renderEmail05(input: {
  appName: string;
  number: string;
  revisionNo: number;
  decision: string;
}): { subject: string; text: string; html: string } {
  const action = input.decision === "approve" ? "accepted" : "declined";
  const subject = `Quote ${input.number} was ${action}`;
  const text = [
    input.appName,
    `The customer ${action} quote ${input.number} R${input.revisionNo}.`,
    "Open the job in the owner app to review the updated status.",
  ].join("\n");
  const html = `<!doctype html><html lang="en"><body>
<p>${escapeHtml(input.appName)}</p>
<p>The customer ${escapeHtml(action)} quote ${escapeHtml(input.number)} R${input.revisionNo}.</p>
<p>Open the job in the owner app to review the updated status.</p>
</body></html>`;
  return { subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

export function reviewHref(portalOrigin: string, token: string): string {
  return `${portalOrigin.replace(/\/$/, "")}/review#${token}`;
}

type ClaimRow = {
  id: string;
  workspace_id: string;
  request_id: string;
  document_id: string;
  delivery_attempt_id: string;
  template_id: string;
  effect_key: string;
  attempts: number;
  created_by: string;
  recipient_email: string;
  business_name: string;
  number: string;
  revision_no: number;
  algorithm: string | null;
  key_version: number | null;
  nonce: Buffer | null;
  ciphertext: Buffer | null;
  fail_without_send: boolean;
  provider_message_id: string | null;
};

export type ResendSendResult =
  | { ok: true; id: string }
  | { ok: false; retryable: boolean; status: number };

export type ResendSender = (input: {
  apiKey: string;
  idempotencyKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}) => Promise<ResendSendResult>;

export async function sendResendEmail(input: {
  apiKey: string;
  idempotencyKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  fetchImpl?: typeof fetch;
}): Promise<ResendSendResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
        open_tracking: false,
        click_tracking: false,
      }),
      signal: controller.signal,
    });
    const status = response.status;
    if (status === 200 || status === 201 || status === 409) {
      let id = "";
      try {
        const json = (await response.json()) as { id?: string };
        id = typeof json.id === "string" ? json.id : "";
      } catch {
        id = "";
      }
      if (!id && status === 409) {
        return { ok: true, id: input.idempotencyKey };
      }
      if (!id) {
        return { ok: false, retryable: true, status };
      }
      return { ok: true, id };
    }
    if (status === 429 || status >= 500) {
      return { ok: false, retryable: true, status };
    }
    if (status >= 400 && status < 500) {
      return { ok: false, retryable: false, status };
    }
    return { ok: false, retryable: true, status };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return { ok: false, retryable: true, status: aborted ? 0 : 0 };
  } finally {
    clearTimeout(timer);
  }
}

function decodeReceipt(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { decision?: unknown };
    return parsed.decision === "approve" || parsed.decision === "decline" ? parsed.decision : "decline";
  } catch {
    return "decline";
  }
}

function asBuffer(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  return undefined;
}

export async function processSendEmail(input: {
  pool: Pool;
  deliverySecret: VersionedSecret | string;
  apiKey: string;
  fromDomain: string;
  portalOrigin: string;
  appName: string;
  send?: ResendSender;
}): Promise<"idle" | "done" | "retry" | "dead"> {
  const claimed = await withWorkerRole(
    input.pool,
    async (client) => {
      const result = await client.query<ClaimRow>("select * from commercial.claim_send_email()");
      const row = result.rows[0];
      if (!row) {
        return undefined;
      }
      await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [
        row.workspace_id,
        row.created_by,
      ]);
      return row;
    },
    { timeoutMs: WORKER_CLAIM_TIMEOUT_MS, statementTimeoutMs: WORKER_STATEMENT_TIMEOUT_MS },
  );
  if (!claimed) {
    return "idle";
  }
  if (claimed.fail_without_send) {
    return "dead";
  }
  if (claimed.provider_message_id) {
    await withWorkerRole(input.pool, async (client) => {
      await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [
        claimed.workspace_id,
        claimed.created_by,
      ]);
      await client.query("select commercial.complete_send_email($1::uuid, $2)", [
        claimed.id,
        claimed.provider_message_id,
      ]);
    });
    return "done";
  }

  const secret =
    typeof input.deliverySecret === "string"
      ? parseVersionedSecret("APPROVAL_DELIVERY_ENCRYPTION_KEY", input.deliverySecret)
      : input.deliverySecret;
  const nonce = asBuffer(claimed.nonce);
  const ciphertext = asBuffer(claimed.ciphertext);
  if (!nonce || !ciphertext || claimed.algorithm !== "aes-256-gcm") {
    await withWorkerRole(input.pool, async (client) => {
      await client.query("select commercial.fail_send_email($1::uuid, $2, $3)", [
        claimed.id,
        "VALIDATION_FAILED",
        true,
      ]);
    });
    return "dead";
  }

  try {
    const payload = { algorithm: "aes-256-gcm" as const, keyVersion: claimed.key_version ?? 1, nonce, ciphertext };
    let rendered: { subject: string; text: string; html: string };
    if (claimed.template_id === "EMAIL01") {
      const raw = decryptDeliveryToken(payload, secret);
      rendered = renderEmail01({
        appName: input.appName,
        businessName: claimed.business_name,
        number: claimed.number,
        revisionNo: Number(claimed.revision_no),
        href: reviewHref(input.portalOrigin, encodeFragmentToken(raw)),
      });
      raw.fill(0);
    } else if (claimed.template_id === "EMAIL03") {
      const code = decryptUtf8(payload, secret);
      rendered = renderEmail03({ appName: input.appName, code });
    } else if (claimed.template_id === "EMAIL04") {
      const decoded = decodeReceipt(decryptUtf8(payload, secret));
      rendered = renderEmail04({
        appName: input.appName,
        businessName: claimed.business_name,
        number: claimed.number,
        revisionNo: Number(claimed.revision_no),
        decision: decoded,
      });
    } else if (claimed.template_id === "EMAIL05") {
      const decoded = decodeReceipt(decryptUtf8(payload, secret));
      rendered = renderEmail05({
        appName: input.appName,
        number: claimed.number,
        revisionNo: Number(claimed.revision_no),
        decision: decoded,
      });
    } else {
      await withWorkerRole(input.pool, async (client) => {
        await client.query("select commercial.fail_send_email($1::uuid, $2, $3)", [
          claimed.id,
          "VALIDATION_FAILED",
          true,
        ]);
      });
      return "dead";
    }
    const from = `${input.appName} <quotes@${input.fromDomain}>`;
    const send = input.send ?? ((payload) => sendResendEmail(payload));
    const result = await whileLeased(input.pool, claimed.id, () =>
      send({
        apiKey: input.apiKey,
        idempotencyKey: claimed.effect_key,
        from,
        to: claimed.recipient_email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      }),
    );
    if (result.ok) {
      await withWorkerRole(input.pool, async (client) => {
        await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [
          claimed.workspace_id,
          claimed.created_by,
        ]);
        await client.query("select commercial.complete_send_email($1::uuid, $2)", [claimed.id, result.id]);
      });
      return "done";
    }
    const status = await withWorkerRole(input.pool, async (client) => {
      const failed = await client.query<{ fail_send_email: string }>(
        "select commercial.fail_send_email($1::uuid, $2, $3) as fail_send_email",
        [claimed.id, result.retryable ? "PROVIDER_RETRY" : "PROVIDER_REJECTED", !result.retryable],
      );
      return failed.rows[0]?.fail_send_email;
    });
    return status === "dead" ? "dead" : "retry";
  } catch {
    await withWorkerRole(input.pool, async (client) => {
      await client.query("select commercial.fail_send_email($1::uuid, $2, $3)", [
        claimed.id,
        "VALIDATION_FAILED",
        true,
      ]);
    });
    return "dead";
  }
}
