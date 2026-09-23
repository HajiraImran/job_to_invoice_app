import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { API_ERROR_CODES, parseDeletionRequest, parseOwnerEmail } from "@job-to-invoice/schemas";
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

type DeletionRow = {
  id: string;
  workspace_id: string;
  status: string;
  requested_at: Date | string;
  verified_at: Date | string;
  purge_after: Date | string;
  purge_deadline: Date | string;
  completed_at: Date | string | null;
  retained_categories_json: unknown;
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

function asIso(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function deletionBody(row: DeletionRow) {
  return {
    id: row.id,
    status: row.status,
    requested_at: asIso(row.requested_at),
    verified_at: asIso(row.verified_at),
    purge_after: asIso(row.purge_after),
    purge_deadline: asIso(row.purge_deadline),
    completed_at: asIso(row.completed_at),
    retained_categories: Array.isArray(row.retained_categories_json) ? row.retained_categories_json : [],
    replayed: row.replayed === true,
  };
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

function grantTokenHash(grant: string): Buffer | undefined {
  try {
    const raw = Buffer.from(grant, "base64url");
    if (raw.length !== 32) {
      raw.fill(0);
      return undefined;
    }
    const digest = createHash("sha256").update(raw).digest();
    raw.fill(0);
    return digest;
  } catch {
    return undefined;
  }
}

export function registerDeletionRoutes(
  app: FastifyInstance,
  deps: {
    verifyJwt?: JwtVerifier;
    pool?: Pool;
  },
  options: { limiterAllow: (key: string) => { ok: true } | { ok: false; retryAfterSec: number } },
): void {
  async function requireOwner(
    request: FastifyRequest,
    reply: FastifyReply,
    mode: "mutate" | "status",
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
    if (mode === "mutate" && owner.account_status !== "active" && owner.account_status !== "deleting") {
      sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
      return undefined;
    }
    if (mode === "status" && owner.account_status !== "active" && owner.account_status !== "deleting") {
      sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
      return undefined;
    }
    if (!owner.setup_completed && owner.account_status === "active") {
      sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      return undefined;
    }
    return owner;
  }

  function mapDeletionError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
    const code = pgCode(error);
    if (code === "P0004") {
      return sendFail(request, reply, API_ERROR_CODES.IDEMPOTENCY_MISMATCH, "Idempotency key was reused with a different body.");
    }
    if (code === "P0003") {
      return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
    }
    if (code === "P0005") {
      return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, "Deletion is not available.");
    }
    if (code === "P0041") {
      return sendFail(request, reply, API_ERROR_CODES.ACTION_GRANT_INVALID, "Confirm it's you again, then retry.");
    }
    if (code === "P0042") {
      return sendFail(request, reply, API_ERROR_CODES.ACTION_GRANT_REQUIRED, "Confirm it's you again, then retry.");
    }
    if (code === "P0059") {
      return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
    }
    if (code === "22023") {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.");
    }
    return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
  }

  app.post("/v1/account/deletion", async (request, reply) => {
    const owner = await requireOwner(request, reply, "mutate");
    if (!owner || !deps.pool) {
      return;
    }
    const parsed = parseDeletionRequest(request.body);
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
    const grant = actionGrantHeader(request);
    if (!grant) {
      return sendFail(request, reply, API_ERROR_CODES.ACTION_GRANT_REQUIRED, "Confirm it's you again, then retry.");
    }
    const grantHash = grantTokenHash(grant);
    if (!grantHash) {
      return sendFail(request, reply, API_ERROR_CODES.ACTION_GRANT_INVALID, "Confirm it's you again, then retry.");
    }
    const hash = requestHash({ action: "deletion", confirmation: parsed.value.confirmation });
    try {
      const row = await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        const result = await client.query<DeletionRow>(
          `select id, workspace_id, status, requested_at, verified_at, purge_after, purge_deadline,
                  completed_at, retained_categories_json, replayed
           from commercial.request_account_deletion($1::uuid, $2::uuid, $3, $4::uuid, $5::bytea, $6::boolean)`,
          [owner.actor_id, key, hash, request.id || randomUUID(), grantHash, true],
        );
        return result.rows[0];
      });
      if (!row) {
        return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
      }
      return reply.status(200).send(success(request.id, deletionBody(row)));
    } catch (error) {
      return mapDeletionError(request, reply, error);
    }
  });

  app.get("/v1/account/deletion", async (request, reply) => {
    const owner = await requireOwner(request, reply, "status");
    if (!owner || !deps.pool) {
      return;
    }
    try {
      const row = await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        const result = await client.query<DeletionRow>(
          `select id, workspace_id, status, requested_at, verified_at, purge_after, purge_deadline,
                  completed_at, retained_categories_json
           from commercial.get_account_deletion($1::uuid)`,
          [owner.actor_id],
        );
        return result.rows[0];
      });
      if (!row) {
        return success(request.id, { deletion: null });
      }
      return success(request.id, { deletion: deletionBody(row) });
    } catch (error) {
      return mapDeletionError(request, reply, error);
    }
  });
}
