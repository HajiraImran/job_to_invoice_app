import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { API_ERROR_CODES, parseOwnerEmail, parseSupportCase, publicSupportUrl } from "@job-to-invoice/schemas";
import type { LoadedApiEnv, LoadedEnv } from "@job-to-invoice/config";
import type { Pool } from "pg";
import { withApiRole, withTenant } from "./db.ts";
import { fail, success } from "./envelope.ts";
import { bearerToken, JwtVerificationError, type JwtVerifier, type VerifiedAccess } from "./jwt.ts";

const GENERIC_AUTH = "Could not verify your session.";
const SIGN_IN_REQUIRED = "Sign in required.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ProvisionRow = {
  actor_id: string;
  workspace_id: string;
  account_status: string;
  display_email: string;
  setup_completed: boolean;
};

type SupportRow = {
  id: string;
  category: string;
  state: string;
  content_access_granted: boolean;
  content_access_expires_at: Date | string | null;
  created_at: Date | string;
  replayed?: boolean;
};

function sendFail(
  request: FastifyRequest,
  reply: FastifyReply,
  code: string,
  message: string,
  extra?: { field_errors?: { field: string; message: string }[] },
) {
  const result = fail(request.id, code, message, { field_errors: extra?.field_errors });
  return reply.status(result.status).send(result.body);
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const raw = request.headers["idempotency-key"];
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

function asIso(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function provisionOwner(pool: Pool, access: VerifiedAccess): Promise<ProvisionRow | undefined> {
  const parsedEmail = parseOwnerEmail(access.email);
  if (!parsedEmail.ok) {
    return undefined;
  }
  return withApiRole(pool, async (client) => {
    const result = await client.query<ProvisionRow>(
      `select actor_id, workspace_id, account_status, display_email, setup_completed
       from identity.provision_owner($1::uuid, $2, $3)`,
      [access.sub, parsedEmail.display, parsedEmail.normalized],
    );
    return result.rows[0];
  });
}

function supportBody(row: SupportRow, supportUrl: string | null) {
  return {
    id: row.id,
    category: row.category,
    state: row.state,
    content_access_granted: row.content_access_granted,
    content_access_expires_at: asIso(row.content_access_expires_at),
    created_at: asIso(row.created_at),
    support_url: supportUrl,
    replayed: row.replayed === true,
  };
}

export function registerSupportRoutes(
  app: FastifyInstance,
  deps: { verifyJwt?: JwtVerifier; pool?: Pool; env: LoadedEnv | LoadedApiEnv },
  options: { limiterAllow: (key: string) => { ok: true } | { ok: false; retryAfterSec: number } },
): void {
  const supportUrl = publicSupportUrl("SUPPORT_URL" in deps.env ? deps.env.SUPPORT_URL : undefined);

  async function requireOwner(
    request: FastifyRequest,
    reply: FastifyReply,
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
    const limited = options.limiterAllow(access.sub);
    if (!limited.ok) {
      const result = fail(request.id, API_ERROR_CODES.RATE_LIMITED, "Too many requests. Try again later.");
      void reply.header("Retry-After", String(limited.retryAfterSec));
      void reply.status(result.status).send(result.body);
      return undefined;
    }
    let owner: ProvisionRow | undefined;
    try {
      owner = await provisionOwner(deps.pool, access);
    } catch {
      sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
      return undefined;
    }
    if (!owner) {
      sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      return undefined;
    }
    if (owner.account_status === "suspended") {
      sendFail(request, reply, API_ERROR_CODES.ACCOUNT_SUSPENDED, "This account cannot make changes.");
      return undefined;
    }
    if (owner.account_status !== "active" && owner.account_status !== "deleting") {
      sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
      return undefined;
    }
    if (!owner.setup_completed && owner.account_status !== "deleting") {
      sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      return undefined;
    }
    return owner;
  }

  app.post("/v1/support/cases", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    const parsed = parseSupportCase(request.body);
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    const key = idempotencyKey(request);
    if (!key || !UUID.test(key)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Idempotency-Key UUID is required.", {
        field_errors: [{ field: "Idempotency-Key", message: "UUID required" }],
      });
    }
    const hash = requestHash({
      category: parsed.value.category,
      message: parsed.value.message,
      grant_content_access: parsed.value.grant_content_access,
    });
    try {
      const row = await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        const result = await client.query<SupportRow>(
          `select id, category, state, content_access_granted, content_access_expires_at, created_at, replayed
           from commercial.create_support_case($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7::boolean)`,
          [
            owner.actor_id,
            key,
            hash,
            request.id,
            parsed.value.category,
            parsed.value.message,
            parsed.value.grant_content_access,
          ],
        );
        return result.rows[0];
      });
      if (!row) {
        return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
      }
      return success(request.id, supportBody(row, supportUrl));
    } catch (error) {
      const code = pgCode(error);
      if (code === "P0004") {
        return sendFail(request, reply, API_ERROR_CODES.IDEMPOTENCY_MISMATCH, "Idempotency key was reused with a different body.");
      }
      if (code === "P0003") {
        return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      }
      if (code === "22023") {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.");
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });
}
