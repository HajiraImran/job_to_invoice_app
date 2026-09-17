import { createHash, createHmac, randomInt } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  decodeFragmentToken,
  encryptRecipientEmail,
  encryptUtf8,
  encodeSessionSecret,
  generateApprovalToken,
  hashApprovalToken,
  hashOtp,
  hashSessionSecret,
  parseVersionedSecret,
  type VersionedSecret,
} from "@job-to-invoice/config";
import { API_ERROR_CODES } from "@job-to-invoice/schemas";
import type { AppDeps } from "./app.ts";
import { withApiRole, ApiTransactionError } from "./db.ts";
import { fail, success } from "./envelope.ts";
import { bearerToken } from "./jwt.ts";
import { allowlistedSqlstate } from "./me-log.ts";
import { RateLimiter } from "./rate-limit.ts";

const COOKIE_NAME = "jti_portal";
const CONSENT_VERSION = "apr04.v1";
const CONSENT_TEXT =
  "I confirm I have reviewed this quote, including the PDF, and I am authorized to approve or decline it. This is not a payment.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

type PortalLogEvent = {
  event: "portal";
  request_id: string;
  status: number;
  stage: string;
  sqlstate?: string;
};

function sendFail(
  request: FastifyRequest,
  reply: FastifyReply,
  code: string,
  message: string,
  extra?: { field_errors?: { field: string; message: string }[]; retryAfter?: number; status?: number },
) {
  const result = fail(request.id, code, message, { field_errors: extra?.field_errors });
  if (extra?.retryAfter !== undefined) {
    void reply.header("Retry-After", String(extra.retryAfter));
  }
  void reply.header("Cache-Control", "no-store");
  void reply.header("Referrer-Policy", "no-referrer");
  return reply.status(extra?.status ?? result.status).send(result.body);
}

function pgCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

function envSecret(env: Record<string, unknown>, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function portalSecrets(env: Record<string, unknown>) {
  const otpKey = envSecret(env, "OTP_HASH_KEY");
  const deliveryKey = envSecret(env, "APPROVAL_DELIVERY_ENCRYPTION_KEY");
  const evidenceKey = envSecret(env, "APPROVAL_EVIDENCE_ENCRYPTION_KEY");
  const tokenKey = envSecret(env, "APPROVAL_TOKEN_HASH_KEY");
  if (!otpKey || !deliveryKey || !evidenceKey || !tokenKey) {
    return undefined;
  }
  try {
    return {
      otp: parseVersionedSecret("OTP_HASH_KEY", otpKey),
      delivery: parseVersionedSecret("APPROVAL_DELIVERY_ENCRYPTION_KEY", deliveryKey),
      evidence: parseVersionedSecret("APPROVAL_EVIDENCE_ENCRYPTION_KEY", evidenceKey),
      token: parseVersionedSecret("APPROVAL_TOKEN_HASH_KEY", tokenKey),
    };
  } catch {
    return undefined;
  }
}

function csrfToken(sessionHash: string, generation: number, secret: VersionedSecret): string {
  return createHmac("sha256", secret.material).update(`csrf:${sessionHash}:${generation}`, "utf8").digest("base64url");
}

function readCookie(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    if (trimmed.slice(0, eq) === COOKIE_NAME) {
      return trimmed.slice(eq + 1);
    }
  }
  return undefined;
}

function clientIp(request: FastifyRequest): string {
  const forwarded = request.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (raw) {
    return raw.split(",")[0]?.trim() || "unknown";
  }
  return request.ip || "unknown";
}

function packedEmail(secret: VersionedSecret, email: string): Buffer {
  const encrypted = encryptRecipientEmail(email, secret);
  return Buffer.concat([encrypted.nonce, encrypted.ciphertext]);
}

function mapPortalSql(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): ReturnType<typeof sendFail> | undefined {
  const code = pgCode(error) ?? (error instanceof ApiTransactionError ? error.sqlstate : undefined);
  if (code === "P0020") {
    return sendFail(request, reply, API_ERROR_CODES.REQUEST_UNAVAILABLE, "This review link is no longer available.");
  }
  if (code === "P0021") {
    return sendFail(
      request,
      reply,
      API_ERROR_CODES.REQUEST_EXPIRED,
      "This request has expired. Ask the business for a new version.",
    );
  }
  if (code === "P0022") {
    return sendFail(request, reply, API_ERROR_CODES.ALREADY_DECIDED, "This quote has already been actioned.");
  }
  if (code === "P0023") {
    return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "That code didn't work. Try again.", {
      field_errors: [{ field: "code", message: "Incorrect code" }],
    });
  }
  if (code === "P0024") {
    return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "That code has expired. Request a new one.", {
      field_errors: [{ field: "code", message: "Expired code" }],
    });
  }
  if (code === "P0025" || code === "P0026" || code === "P0027") {
    return sendFail(request, reply, API_ERROR_CODES.RATE_LIMITED, "Too many attempts. Try again later.", {
      retryAfter: 60,
    });
  }
  if (code === "P0028") {
    return sendFail(request, reply, API_ERROR_CODES.VERSION_CONFLICT, "This quote was decided by another request.", {
      status: 409,
    });
  }
  if (code === "P0030") {
    return sendFail(request, reply, API_ERROR_CODES.ASSET_NOT_READY, "The quote PDF is not ready yet.");
  }
  if (code === "P0031") {
    return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Confirm the acknowledgement before approving.", {
      field_errors: [{ field: "consent_accepted", message: "Required" }],
    });
  }
  if (code === "P0032") {
    return sendFail(request, reply, API_ERROR_CODES.REQUEST_UNAVAILABLE, "This request cannot be decided.", {
      status: 403,
    });
  }
  if (code === "P0033") {
    return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "This quote changed. Reload and try again.", {
      field_errors: [{ field: "snapshot_sha256", message: "Hash mismatch" }],
    });
  }
  if (code === "P0034") {
    return sendFail(request, reply, API_ERROR_CODES.SCOPE_CHANGED, "A newer version is available. This version cannot be approved.");
  }
  if (code === "22023") {
    return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.");
  }
  return undefined;
}

function noStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
  void reply.header("Referrer-Policy", "no-referrer");
}

function logPortal(event: PortalLogEvent, sink?: (event: PortalLogEvent) => void): void {
  const safe: PortalLogEvent = {
    event: "portal",
    request_id: event.request_id,
    status: event.status,
    stage: event.stage,
  };
  const sqlstate = allowlistedSqlstate(event.sqlstate);
  if (sqlstate) {
    safe.sqlstate = sqlstate;
  }
  if (sink) {
    sink(safe);
    return;
  }
  process.stdout.write(`${JSON.stringify(safe)}\n`);
}

export function registerPortalRoutes(app: FastifyInstance, deps: AppDeps): void {
  const otpLimiter = new RateLimiter(20, 60 * 60 * 1000);

  function rejectOwner(request: FastifyRequest, reply: FastifyReply): boolean {
    if (bearerToken(request.headers.authorization)) {
      void sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, "Could not verify your session.");
      return true;
    }
    return false;
  }

  function requireSecrets(request: FastifyRequest, reply: FastifyReply) {
    const secrets = portalSecrets(deps.env ?? {});
    if (!secrets || !deps.pool) {
      void sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
      return undefined;
    }
    return { secrets, pool: deps.pool };
  }

  function requireSession(request: FastifyRequest, reply: FastifyReply, csrfRequired: boolean) {
    const raw = readCookie(request);
    const token = raw ? decodeFragmentToken(raw) : undefined;
    if (!token) {
      void sendFail(request, reply, API_ERROR_CODES.REQUEST_UNAVAILABLE, "This review link is no longer available.");
      return undefined;
    }
    const loaded = requireSecrets(request, reply);
    if (!loaded) {
      return undefined;
    }
    const hashed = hashSessionSecret(token, loaded.secrets.otp);
    if (csrfRequired) {
      const header = request.headers["x-csrf-token"];
      const provided = Array.isArray(header) ? header[0] : header;
      if (!provided) {
        void sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, "Could not verify your session.");
        return undefined;
      }
      return { ...loaded, sessionHash: hashed.hash, csrfProvided: provided, generationHint: undefined as number | undefined };
    }
    return { ...loaded, sessionHash: hashed.hash, csrfProvided: undefined as string | undefined, generationHint: undefined as number | undefined };
  }

  app.post("/v1/portal/exchange", async (request, reply) => {
    noStore(reply);
    if (rejectOwner(request, reply)) {
      return;
    }
    const loaded = requireSecrets(request, reply);
    if (!loaded) {
      return;
    }
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? (request.body as Record<string, unknown>)
      : {};
    if (Object.keys(body).some((key) => key !== "token")) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Unknown fields are not allowed.");
    }
    const rawToken = typeof body.token === "string" ? decodeFragmentToken(body.token) : undefined;
    if (!rawToken) {
      return sendFail(request, reply, API_ERROR_CODES.REQUEST_UNAVAILABLE, "This review link is no longer available.");
    }
    const tokenHash = hashApprovalToken(rawToken, loaded.secrets.token).hash;
    const sessionRaw = generateApprovalToken();
    const session = hashSessionSecret(sessionRaw, loaded.secrets.otp);
    try {
      const row = await withApiRole(loaded.pool, async (client) => {
        const exchanged = await client.query<{
          workspace_id: string;
          request_id: string;
          purpose: string;
          access_state: string;
          business_name: string;
          document_type: string;
          recipient_email_masked: string;
        }>(
          `select workspace_id, request_id, purpose, access_state, business_name, document_type, recipient_email_masked
           from commercial.exchange_approval_token($1, $2)`,
          [tokenHash, session.hash],
        );
        const first = exchanged.rows[0];
        if (first?.workspace_id && first.request_id) {
          await client.query("select identity.set_local_portal_context($1::uuid, $2::uuid)", [
            first.workspace_id,
            first.request_id,
          ]);
        }
        return first;
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.REQUEST_UNAVAILABLE, "This review link is no longer available.");
      }
      logPortal({ event: "portal", request_id: String(request.id), status: 200, stage: "exchange" }, deps.logPortal);
      const sessionNeeded = row.access_state === "pending" || row.access_state === "decided";
      return success(request.id, {
        access_state: row.access_state,
        purpose: row.purpose,
        business_name: row.business_name,
        document_type: row.document_type,
        recipient_email_masked: row.recipient_email_masked,
        csrf_token: sessionNeeded ? csrfToken(session.hash, 0, loaded.secrets.otp) : null,
        session: sessionNeeded ? encodeSessionSecret(sessionRaw) : null,
        max_age_sec: sessionNeeded ? 20 * 60 : 0,
      });
    } catch (error) {
      const mapped = mapPortalSql(request, reply, error);
      if (mapped) {
        return mapped;
      }
      logPortal(
        {
          event: "portal",
          request_id: String(request.id),
          status: 503,
          stage: "exchange_failed",
          sqlstate: pgCode(error),
        },
        deps.logPortal,
      );
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.post("/v1/portal/code/send", async (request, reply) => {
    noStore(reply);
    if (rejectOwner(request, reply)) {
      return;
    }
    const session = requireSession(request, reply, true);
    if (!session) {
      return;
    }
    const ip = clientIp(request);
    const limited = otpLimiter.allow(`otp:${ip}`);
    if (!limited.ok) {
      return sendFail(request, reply, API_ERROR_CODES.RATE_LIMITED, "Too many attempts. Try again later.", {
        retryAfter: limited.retryAfterSec,
      });
    }
    try {
      const row = await withApiRole(session.pool, async (client) => {
        const resolved = await client.query<{
          workspace_id: string;
          request_id: string;
          token_generation: number;
          recipient_email: string;
        }>(
          `select workspace_id, request_id, token_generation, recipient_email from commercial.resolve_portal_session($1)`,
          [session.sessionHash],
        );
        const first = resolved.rows[0];
        if (!first || first.token_generation !== 0) {
          throw Object.assign(new Error("unavailable"), { code: "P0020" });
        }
        const expectedCsrf = csrfToken(session.sessionHash, 0, session.secrets.otp);
        if (session.csrfProvided !== expectedCsrf) {
          throw Object.assign(new Error("csrf"), { code: "28P01" });
        }
        await client.query("select identity.set_local_portal_context($1::uuid, $2::uuid)", [
          first.workspace_id,
          first.request_id,
        ]);
        const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
        const hashed = hashOtp(code, session.secrets.otp);
        const encryptedCode = encryptUtf8(code, session.secrets.delivery);
        const packed = packedEmail(session.secrets.delivery, first.recipient_email);
        const sent = await client.query<{ retry_after_sec: number }>(
          `select retry_after_sec from commercial.send_portal_code($1, $2, $3::integer, $4::bytea, $5, $6::integer, $7::bytea, $8::bytea)`,
          [
            session.sessionHash,
            hashed.hash,
            hashed.keyVersion,
            packed,
            encryptedCode.algorithm,
            encryptedCode.keyVersion,
            encryptedCode.nonce,
            encryptedCode.ciphertext,
          ],
        );
        return { retry: sent.rows[0]?.retry_after_sec ?? 60 };
      });
      logPortal({ event: "portal", request_id: String(request.id), status: 202, stage: "code_send" }, deps.logPortal);
      return reply.status(202).send(success(request.id, { sent: true, retry_after_sec: row.retry }));
    } catch (error) {
      if (pgCode(error) === "28P01") {
        return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, "Could not verify your session.");
      }
      const mapped = mapPortalSql(request, reply, error);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.post("/v1/portal/code/verify", async (request, reply) => {
    noStore(reply);
    if (rejectOwner(request, reply)) {
      return;
    }
    const session = requireSession(request, reply, true);
    if (!session) {
      return;
    }
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? (request.body as Record<string, unknown>)
      : {};
    if (Object.keys(body).some((key) => key !== "code")) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Unknown fields are not allowed.");
    }
    if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Enter the 6-digit code.", {
        field_errors: [{ field: "code", message: "6 digits required" }],
      });
    }
    const expectedCsrf = csrfToken(session.sessionHash, 0, session.secrets.otp);
    if (session.csrfProvided !== expectedCsrf) {
      return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, "Could not verify your session.");
    }
    const hashed = hashOtp(body.code, session.secrets.otp);
    try {
      const row = await withApiRole(session.pool, async (client) => {
        const verified = await client.query<{
          workspace_id: string;
          request_id: string;
          access_state: string;
          error_code: string | null;
        }>(`select workspace_id, request_id, access_state, error_code from commercial.verify_portal_code($1, $2)`, [
          session.sessionHash,
          hashed.hash,
        ]);
        const first = verified.rows[0];
        if (first?.workspace_id && !first.error_code) {
          await client.query("select identity.set_local_portal_context($1::uuid, $2::uuid)", [
            first.workspace_id,
            first.request_id,
          ]);
        }
        return first;
      });
      if (row?.error_code) {
        const mapped = mapPortalSql(request, reply, Object.assign(new Error(row.error_code), { code: row.error_code }));
        if (mapped) {
          return mapped;
        }
      }
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.REQUEST_UNAVAILABLE, "This review link is no longer available.");
      }
      return success(request.id, {
        access_state: row.access_state,
        csrf_token: csrfToken(session.sessionHash, 1, session.secrets.otp),
        max_age_sec: 60 * 60,
      });
    } catch (error) {
      const mapped = mapPortalSql(request, reply, error);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.get("/v1/portal/document", async (request, reply) => {
    noStore(reply);
    if (rejectOwner(request, reply)) {
      return;
    }
    const session = requireSession(request, reply, false);
    if (!session) {
      return;
    }
    try {
      const row = await withApiRole(session.pool, async (client) => {
        const resolved = await client.query<{ workspace_id: string; request_id: string; token_generation: number }>(
          `select workspace_id, request_id, token_generation from commercial.resolve_portal_session($1)`,
          [session.sessionHash],
        );
        const first = resolved.rows[0];
        if (!first || first.token_generation < 1) {
          return undefined;
        }
        await client.query("select identity.set_local_portal_context($1::uuid, $2::uuid)", [
          first.workspace_id,
          first.request_id,
        ]);
        const doc = await client.query<{
          workspace_id: string;
          request_id: string;
          document_id: string;
          purpose: string;
          access_state: string;
          business_name: string;
          number: string;
          revision_no: number;
          lifecycle: string;
          snapshot_json: unknown;
          snapshot_sha256: string;
          pdf_state: string;
          consent_version: string;
          consent_text: string;
          allowed_actions: string[];
        }>(
          `select workspace_id, request_id, document_id, purpose, access_state, business_name, number, revision_no,
                  lifecycle, snapshot_json, snapshot_sha256, pdf_state, consent_version, consent_text, allowed_actions
           from commercial.get_portal_document($1)`,
          [session.sessionHash],
        );
        return doc.rows[0];
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.REQUEST_UNAVAILABLE, "This review link is no longer available.");
      }
      return success(request.id, {
        access_state: row.access_state,
        purpose: row.purpose,
        business_name: row.business_name,
        number: row.number,
        revision_label: `R${row.revision_no}`,
        lifecycle: row.lifecycle,
        snapshot: row.snapshot_json,
        snapshot_sha256: row.snapshot_sha256,
        pdf_state: row.pdf_state,
        consent_version: row.consent_version,
        consent_text: row.consent_text,
        allowed_actions: row.allowed_actions,
        document_id: row.document_id,
      });
    } catch (error) {
      const mapped = mapPortalSql(request, reply, error);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.get("/v1/portal/download", async (request, reply) => {
    noStore(reply);
    if (rejectOwner(request, reply)) {
      return;
    }
    const session = requireSession(request, reply, false);
    if (!session) {
      return;
    }
    try {
      const row = await withApiRole(session.pool, async (client) => {
        const resolved = await client.query<{ workspace_id: string; request_id: string; token_generation: number }>(
          `select workspace_id, request_id, token_generation from commercial.resolve_portal_session($1)`,
          [session.sessionHash],
        );
        const first = resolved.rows[0];
        if (!first || first.token_generation < 1) {
          return undefined;
        }
        await client.query("select identity.set_local_portal_context($1::uuid, $2::uuid)", [
          first.workspace_id,
          first.request_id,
        ]);
        const download = await client.query<{ download_state: string; object_key: string | null; document_id: string }>(
          `select download_state, object_key, document_id from commercial.portal_pdf_download($1)`,
          [session.sessionHash],
        );
        return download.rows[0];
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.REQUEST_UNAVAILABLE, "This review link is no longer available.");
      }
      if (row.download_state === "ready") {
        if (!row.object_key || !deps.documentsStore) {
          return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
        }
        const url = await deps.documentsStore.presignGet(row.object_key);
        return success(request.id, { document_id: row.document_id, state: "ready", url });
      }
      return success(request.id, { document_id: row.document_id, state: row.download_state, url: null });
    } catch (error) {
      const mapped = mapPortalSql(request, reply, error);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.get("/v1/portal/receipt", async (request, reply) => {
    noStore(reply);
    if (rejectOwner(request, reply)) {
      return;
    }
    const session = requireSession(request, reply, false);
    if (!session) {
      return;
    }
    try {
      const row = await withApiRole(session.pool, async (client) => {
        const resolved = await client.query<{ workspace_id: string; request_id: string; token_generation: number }>(
          `select workspace_id, request_id, token_generation from commercial.resolve_portal_session($1)`,
          [session.sessionHash],
        );
        const first = resolved.rows[0];
        if (!first || first.token_generation < 1) {
          return undefined;
        }
        await client.query("select identity.set_local_portal_context($1::uuid, $2::uuid)", [
          first.workspace_id,
          first.request_id,
        ]);
        const receipt = await client.query<{
          access_state: string;
          decision: string | null;
          decided_at: Date | string | null;
          number: string;
          revision_no: number;
          signer_name: string | null;
          comment: string | null;
        }>(
          `select access_state, decision, decided_at, number, revision_no, signer_name, comment
           from commercial.get_portal_receipt($1)`,
          [session.sessionHash],
        );
        return receipt.rows[0];
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.REQUEST_UNAVAILABLE, "This review link is no longer available.");
      }
      return success(request.id, {
        access_state: row.access_state,
        decision: row.decision,
        decided_at: row.decided_at instanceof Date ? row.decided_at.toISOString() : row.decided_at,
        number: row.number,
        revision_label: `R${row.revision_no}`,
        signer_name: row.signer_name,
        comment: row.comment,
        payment_claimed: false,
      });
    } catch (error) {
      const mapped = mapPortalSql(request, reply, error);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.post("/v1/portal/report", async (request, reply) => {
    noStore(reply);
    if (rejectOwner(request, reply)) {
      return;
    }
    const session = requireSession(request, reply, true);
    if (!session) {
      return;
    }
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? (request.body as Record<string, unknown>)
      : {};
    if (Object.keys(body).some((key) => key !== "reason")) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Unknown fields are not allowed.");
    }
    if (typeof body.reason !== "string" || !["unexpected", "wrong_recipient", "suspicious"].includes(body.reason)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Choose a report reason.", {
        field_errors: [{ field: "reason", message: "Required" }],
      });
    }
    try {
      await withApiRole(session.pool, async (client) => {
        const resolved = await client.query<{
          workspace_id: string;
          request_id: string;
          token_generation: number;
        }>(`select workspace_id, request_id, token_generation from commercial.resolve_portal_session($1)`, [
          session.sessionHash,
        ]);
        const first = resolved.rows[0];
        if (!first) {
          throw Object.assign(new Error("unavailable"), { code: "P0020" });
        }
        const expectedCsrf = csrfToken(session.sessionHash, first.token_generation, session.secrets.otp);
        if (session.csrfProvided !== expectedCsrf) {
          throw Object.assign(new Error("csrf"), { code: "28P01" });
        }
        await client.query("select identity.set_local_portal_context($1::uuid, $2::uuid)", [
          first.workspace_id,
          first.request_id,
        ]);
        await client.query(`select commercial.report_portal_abuse($1, $2)`, [session.sessionHash, body.reason]);
      });
      return reply.status(202).send(success(request.id, { reported: true }));
    } catch (error) {
      if (pgCode(error) === "28P01") {
        return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, "Could not verify your session.");
      }
      const mapped = mapPortalSql(request, reply, error);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.post("/v1/portal/decision", async (request, reply) => {
    noStore(reply);
    if (rejectOwner(request, reply)) {
      return;
    }
    const session = requireSession(request, reply, true);
    if (!session) {
      return;
    }
    const idempotency = request.headers["idempotency-key"];
    const key = Array.isArray(idempotency) ? idempotency[0] : idempotency;
    if (!key || !UUID.test(key)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Idempotency-Key UUID is required.", {
        field_errors: [{ field: "Idempotency-Key", message: "UUID required" }],
      });
    }
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? (request.body as Record<string, unknown>)
      : {};
    const allowed = new Set(["decision", "signer_name", "consent_version", "consent_accepted", "snapshot_sha256", "comment"]);
    if (Object.keys(body).some((field) => !allowed.has(field))) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Unknown fields are not allowed.");
    }
    if (body.decision !== "approve" && body.decision !== "decline") {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Choose approve or decline.", {
        field_errors: [{ field: "decision", message: "Required" }],
      });
    }
    const signerName = typeof body.signer_name === "string" ? body.signer_name.trim() : "";
    if (signerName.length < 1 || signerName.length > 120) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Enter the name used to sign.", {
        field_errors: [{ field: "signer_name", message: "Required" }],
      });
    }
    if (body.consent_version !== CONSENT_VERSION) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Reload and try again.", {
        field_errors: [{ field: "consent_version", message: "Required" }],
      });
    }
    if (body.decision === "approve" && body.consent_accepted !== true) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Confirm the acknowledgement before approving.", {
        field_errors: [{ field: "consent_accepted", message: "Required" }],
      });
    }
    if (typeof body.snapshot_sha256 !== "string" || !SHA256_HEX.test(body.snapshot_sha256)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Reload and try again.", {
        field_errors: [{ field: "snapshot_sha256", message: "Required" }],
      });
    }
    const comment = body.comment === undefined || body.comment === null ? null : body.comment;
    if (comment !== null && (typeof comment !== "string" || comment.length > 1000)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Comment must be 1000 characters or fewer.", {
        field_errors: [{ field: "comment", message: "Too long" }],
      });
    }
    const evidence = encryptUtf8(
      JSON.stringify({
        ua: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"].slice(0, 400) : "",
        ip: createHash("sha256").update(clientIp(request)).digest("hex"),
      }),
      session.secrets.evidence,
    );
    const receipt = encryptUtf8(JSON.stringify({ kind: "receipt", decision: body.decision }), session.secrets.delivery);
    try {
      const row = await withApiRole(session.pool, async (client) => {
        const resolved = await client.query<{
          workspace_id: string;
          request_id: string;
          token_generation: number;
        }>(`select workspace_id, request_id, token_generation from commercial.resolve_portal_session($1)`, [
          session.sessionHash,
        ]);
        const first = resolved.rows[0];
        if (!first || first.token_generation < 1) {
          throw Object.assign(new Error("unavailable"), { code: "P0020" });
        }
        const expectedCsrf = csrfToken(session.sessionHash, first.token_generation, session.secrets.otp);
        if (session.csrfProvided !== expectedCsrf) {
          throw Object.assign(new Error("csrf"), { code: "28P01" });
        }
        await client.query("select identity.set_local_portal_context($1::uuid, $2::uuid)", [
          first.workspace_id,
          first.request_id,
        ]);
        const recipient = await client.query<{ recipient_email: string; owner_email: string }>(
          `select recipient_email, owner_email from commercial.resolve_portal_session($1)`,
          [session.sessionHash],
        );
        const emails = recipient.rows[0];
        if (!emails) {
          throw Object.assign(new Error("unavailable"), { code: "P0020" });
        }
        const email04 = packedEmail(session.secrets.delivery, emails.recipient_email);
        const email05 = packedEmail(session.secrets.delivery, emails.owner_email);
        const decided = await client.query<{
          request_id: string;
          document_id: string;
          decision: string;
          decided_at: Date | string;
          number: string;
          revision_no: number;
          replayed: boolean;
        }>(
          `select request_id, document_id, decision, decided_at, number, revision_no, replayed
           from commercial.decide_portal_quote(
             $1, $2::uuid, $3, $4, $5, $6, $7::boolean, $8, $9, $10::jsonb, $11::integer,
             $12::bytea, $13, $14::integer, $15::bytea, $16::bytea,
             $17::bytea, $18, $19::integer, $20::bytea, $21::bytea
           )`,
          [
            session.sessionHash,
            key,
            body.decision,
            signerName,
            CONSENT_VERSION,
            CONSENT_TEXT,
            body.consent_accepted === true,
            body.snapshot_sha256,
            comment,
            JSON.stringify({
              algorithm: evidence.algorithm,
              key_version: evidence.keyVersion,
              nonce: evidence.nonce.toString("base64"),
              ciphertext: evidence.ciphertext.toString("base64"),
            }),
            evidence.keyVersion,
            email04,
            receipt.algorithm,
            receipt.keyVersion,
            receipt.nonce,
            receipt.ciphertext,
            email05,
            receipt.algorithm,
            receipt.keyVersion,
            receipt.nonce,
            receipt.ciphertext,
          ],
        );
        return decided.rows[0];
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.REQUEST_UNAVAILABLE, "This review link is no longer available.");
      }
      logPortal({ event: "portal", request_id: String(request.id), status: 200, stage: "decision" }, deps.logPortal);
      return success(request.id, {
        decision: row.decision,
        decided_at: row.decided_at instanceof Date ? row.decided_at.toISOString() : row.decided_at,
        number: row.number,
        revision_label: `R${row.revision_no}`,
        replayed: row.replayed,
        payment_claimed: false,
      });
    } catch (error) {
      if (pgCode(error) === "28P01") {
        return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, "Could not verify your session.");
      }
      const mapped = mapPortalSql(request, reply, error);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });
}

export type { PortalLogEvent };
