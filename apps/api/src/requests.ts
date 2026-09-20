import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  encryptDeliveryToken,
  encryptRecipientEmail,
  encryptUtf8,
  generateApprovalToken,
  hashApprovalToken,
  parseVersionedSecret,
} from "@job-to-invoice/config";
import {
  API_ERROR_CODES,
  isClientUuid,
  parseEmptyObjectBody,
  parseOwnerEmail,
  parseWithdrawBody,
} from "@job-to-invoice/schemas";
import type { Pool } from "pg";
import { withApiRole } from "./db.ts";
import { fail, success } from "./envelope.ts";
import { bearerToken, JwtVerificationError, type JwtVerifier, type VerifiedAccess } from "./jwt.ts";

const GENERIC_AUTH = "Could not verify your session.";
const SIGN_IN_REQUIRED = "Sign in required.";
const REQUEST_NOT_FOUND = "Request was not found.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ProvisionRow = {
  actor_id: string;
  workspace_id: string;
  account_status: string;
  display_email: string;
  setup_completed: boolean;
};

function sendFail(
  request: FastifyRequest,
  reply: FastifyReply,
  code: string,
  message: string,
  extra?: { field_errors?: { field: string; message: string }[]; retryAfterSec?: number },
) {
  const result = fail(request.id, code, message, { field_errors: extra?.field_errors });
  if (extra?.retryAfterSec !== undefined) {
    void reply.header("Retry-After", String(extra.retryAfterSec));
  }
  return reply.status(result.status).send(result.body);
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const raw = request.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

function actionGrantHeader(request: FastifyRequest): string | undefined {
  const raw = request.headers["x-action-grant"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

function requestHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function pgCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

function pgHint(error: unknown): string | undefined {
  if (error && typeof error === "object" && "hint" in error && typeof error.hint === "string") {
    return error.hint;
  }
  return undefined;
}

function asIso(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(value).toISOString();
}

function mapMutationError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): ReturnType<typeof sendFail> | undefined {
  const code = pgCode(error);
  if (code === "P0005") {
    return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, REQUEST_NOT_FOUND);
  }
  if (code === "P0004") {
    return sendFail(request, reply, API_ERROR_CODES.IDEMPOTENCY_MISMATCH, "This request does not match the original.");
  }
  if (code === "P0001") {
    return sendFail(request, reply, API_ERROR_CODES.VERSION_CONFLICT, "This request changed. Refresh and try again.");
  }
  if (code === "P0022") {
    return sendFail(request, reply, API_ERROR_CODES.ALREADY_DECIDED, "This request is already finalized.");
  }
  if (code === "P0020") {
    return sendFail(request, reply, API_ERROR_CODES.REQUEST_UNAVAILABLE, "This request is no longer available.");
  }
  if (code === "P0021") {
    return sendFail(request, reply, API_ERROR_CODES.REQUEST_EXPIRED, "This request has expired.");
  }
  if (code === "P0040") {
    const hint = Number(pgHint(error) ?? "60");
    const retryAfterSec = Number.isFinite(hint) && hint > 0 ? Math.floor(hint) : 60;
    return sendFail(
      request,
      reply,
      API_ERROR_CODES.RATE_LIMITED,
      "Resend is limited. Try again later.",
      { retryAfterSec },
    );
  }
  if (code === "P0041") {
    return sendFail(request, reply, API_ERROR_CODES.ACTION_GRANT_INVALID, "Confirm it's you again, then retry.");
  }
  if (code === "P0042") {
    return sendFail(request, reply, API_ERROR_CODES.ACTION_GRANT_REQUIRED, "Confirm it's you again, then retry.");
  }
  if (code === "23514" || code === "22023") {
    return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.");
  }
  return undefined;
}

async function requireOwner(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: { verifyJwt?: JwtVerifier; pool?: Pool },
  limiterAllow: (key: string) => { ok: true } | { ok: false; retryAfterSec: number },
): Promise<ProvisionRow | undefined> {
  const token = bearerToken(request.headers.authorization);
  if (!token) {
    sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_REQUIRED, SIGN_IN_REQUIRED);
    return undefined;
  }
  if (!deps.verifyJwt || !deps.pool) {
    sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    return undefined;
  }
  let access: VerifiedAccess;
  try {
    access = await deps.verifyJwt(token);
  } catch (error) {
    if (error instanceof JwtVerificationError) {
      sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      return undefined;
    }
    sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
    return undefined;
  }
  const parsedEmail = parseOwnerEmail(access.email);
  if (!parsedEmail.ok) {
    sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
    return undefined;
  }
  const limited = limiterAllow(access.sub);
  if (!limited.ok) {
    const result = fail(request.id, API_ERROR_CODES.RATE_LIMITED, "Too many requests. Try again later.");
    void reply.header("Retry-After", String(limited.retryAfterSec));
    void reply.status(result.status).send(result.body);
    return undefined;
  }
  try {
    const owner = await withApiRole(deps.pool, async (client) => {
      const result = await client.query<ProvisionRow>(
        `select actor_id, workspace_id, account_status, display_email, setup_completed
         from identity.provision_owner($1::uuid, $2, $3)`,
        [access.sub, parsedEmail.display, parsedEmail.normalized],
      );
      return result.rows[0];
    });
    if (!owner) {
      sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      return undefined;
    }
    if (owner.account_status === "suspended") {
      sendFail(request, reply, API_ERROR_CODES.ACCOUNT_SUSPENDED, "This account cannot make changes.");
      return undefined;
    }
    if (owner.account_status !== "active") {
      sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
      return undefined;
    }
    if (!owner.setup_completed) {
      sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      return undefined;
    }
    return owner;
  } catch {
    sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    return undefined;
  }
}

function loadSecrets(env?: Record<string, unknown>) {
  const tokenRaw = typeof env?.APPROVAL_TOKEN_HASH_KEY === "string" ? env.APPROVAL_TOKEN_HASH_KEY : undefined;
  const deliveryRaw =
    typeof env?.APPROVAL_DELIVERY_ENCRYPTION_KEY === "string" ? env.APPROVAL_DELIVERY_ENCRYPTION_KEY : undefined;
  if (!tokenRaw || !deliveryRaw) {
    return undefined;
  }
  return {
    token: parseVersionedSecret("APPROVAL_TOKEN_HASH_KEY", tokenRaw),
    delivery: parseVersionedSecret("APPROVAL_DELIVERY_ENCRYPTION_KEY", deliveryRaw),
  };
}

export function registerRequestMutationRoutes(
  app: FastifyInstance,
  deps: {
    env?: Record<string, unknown>;
    verifyJwt?: JwtVerifier;
    pool?: Pool;
  },
  options: { limiterAllow: (key: string) => { ok: true } | { ok: false; retryAfterSec: number } },
): void {
  app.post("/v1/requests/:requestId/resend", async (request, reply) => {
    const owner = await requireOwner(request, reply, deps, options.limiterAllow);
    if (!owner || !deps.pool) {
      return;
    }
    const params = request.params as { requestId?: string };
    if (!isClientUuid(params.requestId)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "requestId", message: "A request UUID is required." }],
      });
    }
    const empty = parseEmptyObjectBody(request.body);
    if (!empty.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: empty.field_errors,
      });
    }
    const key = idempotencyKey(request);
    if (!key || !UUID.test(key)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "Idempotency-Key", message: "A UUID Idempotency-Key is required." }],
      });
    }
    const secrets = loadSecrets(deps.env);
    if (!secrets) {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
    const hash = requestHash({ request_id: params.requestId, action: "resend" });
    const approvalToken = generateApprovalToken();
    try {
      const hashed = hashApprovalToken(approvalToken, secrets.token);
      const encrypted = encryptDeliveryToken(approvalToken, secrets.delivery);
      const packedEmail = encryptRecipientEmail("placeholder@invalid.example", secrets.delivery);
      const row = await withApiRole(deps.pool, async (client) => {
        const result = await client.query<{
          request_id: string;
          document_id: string;
          job_id: string;
          request_state: string;
          token_rotated_at: Date | string;
          delivery_state: string;
          number: string;
          revision_no: number;
          resends_used_today: number;
          resend_available_at: Date | string | null;
          can_resend: boolean;
          replayed: boolean;
        }>(
          `select * from commercial.resend_approval_request(
             $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::integer,
             $7::bytea, $8, $9::integer, $10::bytea, $11::bytea
           )`,
          [
            owner.actor_id,
            params.requestId,
            key,
            hash,
            hashed.hash,
            hashed.keyVersion,
            Buffer.concat([packedEmail.nonce, packedEmail.ciphertext]),
            encrypted.algorithm,
            encrypted.keyVersion,
            encrypted.nonce,
            encrypted.ciphertext,
          ],
        );
        return result.rows[0];
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, REQUEST_NOT_FOUND);
      }
      return reply.status(202).send(
        success(request.id, {
          request_id: row.request_id,
          document_id: row.document_id,
          job_id: row.job_id,
          request_state: row.request_state,
          token_rotated_at: asIso(row.token_rotated_at),
          delivery_state: row.delivery_state,
          number: row.number,
          revision_label: `R${row.revision_no}`,
          revision_no: row.revision_no,
          resends_used_today: Number(row.resends_used_today),
          resend_available_at: asIso(row.resend_available_at),
          can_resend: row.can_resend,
          replayed: row.replayed,
        }),
      );
    } catch (error) {
      const mapped = mapMutationError(request, reply, error);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    } finally {
      approvalToken.fill(0);
    }
  });

  app.post("/v1/requests/:requestId/withdraw", async (request, reply) => {
    const owner = await requireOwner(request, reply, deps, options.limiterAllow);
    if (!owner || !deps.pool) {
      return;
    }
    const params = request.params as { requestId?: string };
    if (!isClientUuid(params.requestId)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "requestId", message: "A request UUID is required." }],
      });
    }
    const parsed = parseWithdrawBody(request.body);
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    const key = idempotencyKey(request);
    if (!key || !UUID.test(key)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "Idempotency-Key", message: "A UUID Idempotency-Key is required." }],
      });
    }
    const secrets = loadSecrets(deps.env);
    if (!secrets) {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
    const hash = requestHash({ request_id: params.requestId, action: "withdraw", reason: parsed.value.reason });
    const payload = encryptUtf8(JSON.stringify({ kind: "withdrawn" }), secrets.delivery);
    const packedEmail = encryptRecipientEmail("placeholder@invalid.example", secrets.delivery);
    try {
      const row = await withApiRole(deps.pool, async (client) => {
        const result = await client.query<{
          request_id: string;
          document_id: string;
          job_id: string;
          request_state: string;
          decided_at: Date | string;
          number: string;
          revision_no: number;
          replayed: boolean;
        }>(
          `select * from commercial.withdraw_approval_request(
             $1::uuid, $2::uuid, $3, $4::uuid, $5,
             $6::bytea, $7, $8::integer, $9::bytea, $10::bytea
           )`,
          [
            owner.actor_id,
            params.requestId,
            parsed.value.reason,
            key,
            hash,
            Buffer.concat([packedEmail.nonce, packedEmail.ciphertext]),
            payload.algorithm,
            payload.keyVersion,
            payload.nonce,
            payload.ciphertext,
          ],
        );
        return result.rows[0];
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, REQUEST_NOT_FOUND);
      }
      return success(request.id, {
        request_id: row.request_id,
        document_id: row.document_id,
        job_id: row.job_id,
        request_state: row.request_state,
        decided_at: asIso(row.decided_at),
        number: row.number,
        revision_label: `R${row.revision_no}`,
        revision_no: row.revision_no,
        replayed: row.replayed,
      });
    } catch (error) {
      const mapped = mapMutationError(request, reply, error);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.post("/v1/requests/:requestId/replace-link", async (request, reply) => {
    const owner = await requireOwner(request, reply, deps, options.limiterAllow);
    if (!owner || !deps.pool) {
      return;
    }
    const params = request.params as { requestId?: string };
    if (!isClientUuid(params.requestId)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "requestId", message: "A request UUID is required." }],
      });
    }
    const empty = parseEmptyObjectBody(request.body);
    if (!empty.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: empty.field_errors,
      });
    }
    const key = idempotencyKey(request);
    if (!key || !UUID.test(key)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "Idempotency-Key", message: "A UUID Idempotency-Key is required." }],
      });
    }
    const grant = actionGrantHeader(request);
    if (!grant) {
      return sendFail(request, reply, API_ERROR_CODES.ACTION_GRANT_REQUIRED, "Confirm it's you again, then retry.");
    }
    let grantHash: Buffer;
    try {
      const raw = Buffer.from(grant, "base64url");
      if (raw.length !== 32) {
        return sendFail(request, reply, API_ERROR_CODES.ACTION_GRANT_INVALID, "Confirm it's you again, then retry.");
      }
      grantHash = createHash("sha256").update(raw).digest();
      raw.fill(0);
    } catch {
      return sendFail(request, reply, API_ERROR_CODES.ACTION_GRANT_INVALID, "Confirm it's you again, then retry.");
    }
    const secrets = loadSecrets(deps.env);
    if (!secrets) {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
    const hash = requestHash({ request_id: params.requestId, action: "replace_link" });
    const approvalToken = generateApprovalToken();
    try {
      const hashed = hashApprovalToken(approvalToken, secrets.token);
      const encrypted = encryptDeliveryToken(approvalToken, secrets.delivery);
      const packedEmail = encryptRecipientEmail("placeholder@invalid.example", secrets.delivery);
      const row = await withApiRole(deps.pool, async (client) => {
        const result = await client.query<{
          request_id: string;
          document_id: string;
          job_id: string;
          request_state: string;
          token_rotated_at: Date | string;
          delivery_state: string;
          number: string;
          revision_no: number;
          replayed: boolean;
        }>(
          `select * from commercial.replace_link_approval_request(
             $1::uuid, $2::uuid, $3::uuid, $4, $5::bytea, $6, $7::integer,
             $8::bytea, $9, $10::integer, $11::bytea, $12::bytea
           )`,
          [
            owner.actor_id,
            params.requestId,
            key,
            hash,
            grantHash,
            hashed.hash,
            hashed.keyVersion,
            Buffer.concat([packedEmail.nonce, packedEmail.ciphertext]),
            encrypted.algorithm,
            encrypted.keyVersion,
            encrypted.nonce,
            encrypted.ciphertext,
          ],
        );
        return result.rows[0];
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, REQUEST_NOT_FOUND);
      }
      return reply.status(202).send(
        success(request.id, {
          request_id: row.request_id,
          document_id: row.document_id,
          job_id: row.job_id,
          request_state: row.request_state,
          token_rotated_at: asIso(row.token_rotated_at),
          delivery_state: row.delivery_state,
          number: row.number,
          revision_label: `R${row.revision_no}`,
          revision_no: row.revision_no,
          replayed: row.replayed,
        }),
      );
    } catch (error) {
      const mapped = mapMutationError(request, reply, error);
      if (mapped) {
        return mapped;
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    } finally {
      approvalToken.fill(0);
      grantHash.fill(0);
    }
  });
}
