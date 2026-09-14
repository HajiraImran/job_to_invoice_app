import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parseOwnerEmail, parseWorkspaceSetup } from "@job-to-invoice/schemas";
import type { Pool } from "pg";
import { withApiRole } from "./db.ts";
import { API_ERROR_CODES, fail, success } from "./envelope.ts";
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
  first_sign_in: boolean;
  analytics_alias_id: string;
  workspace_version: number;
};

type SetupRow = ProvisionRow & { replayed: boolean };

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

function ifMatchVersion(request: FastifyRequest): number | undefined {
  const raw = request.headers["if-match"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    return undefined;
  }
  const cleaned = value.replace(/^W\//, "").replaceAll('"', "").trim();
  if (!/^[1-9]\d*$/.test(cleaned)) {
    return undefined;
  }
  return Number(cleaned);
}

function requestHash(body: unknown, expectedVersion: number): string {
  return createHash("sha256").update(JSON.stringify({ body, expectedVersion })).digest("hex");
}

function bootstrapFrom(row: ProvisionRow) {
  return {
    user: {
      id: row.actor_id,
      status: row.account_status,
      display_email: row.display_email,
    },
    workspace: {
      id: row.workspace_id,
      version: row.workspace_version,
      setup_completed: row.setup_completed,
    },
    entitlement: {
      source: "unverified",
      can_publish: false,
    },
    first_sign_in: row.first_sign_in,
    analytics_alias_id: row.analytics_alias_id,
  };
}

function pgCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  deps: { verifyJwt?: JwtVerifier; pool?: Pool },
  options: { limiterAllow: (key: string) => { ok: true } | { ok: false; retryAfterSec: number } },
): void {
  app.post("/v1/workspace", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_REQUIRED, SIGN_IN_REQUIRED);
    }
    if (!deps.verifyJwt || !deps.pool) {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
    const key = idempotencyKey(request);
    if (!key || !UUID.test(key)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Idempotency-Key UUID is required.", {
        field_errors: [{ field: "Idempotency-Key", message: "UUID required" }],
      });
    }
    const expectedVersion = ifMatchVersion(request);
    if (expectedVersion === undefined) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "If-Match workspace version is required.", {
        field_errors: [{ field: "If-Match", message: "Workspace version required" }],
      });
    }
    let access: VerifiedAccess;
    try {
      access = await deps.verifyJwt(token);
    } catch (error) {
      if (error instanceof JwtVerificationError) {
        return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      }
      return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
    }
    const parsedEmail = parseOwnerEmail(access.email);
    if (!parsedEmail.ok) {
      return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
    }
    const limited = options.limiterAllow(access.sub);
    if (!limited.ok) {
      const result = fail(request.id, API_ERROR_CODES.RATE_LIMITED, "Too many requests. Try again later.");
      void reply.header("Retry-After", String(limited.retryAfterSec));
      return reply.status(result.status).send(result.body);
    }
    const body = request.body === undefined || request.body === null ? {} : request.body;
    const parsed = parseWorkspaceSetup(body);
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    const hash = requestHash(body, expectedVersion);
    try {
      const row = await withApiRole(deps.pool, async (client) => {
        const owner = await client.query<ProvisionRow>(
          `select actor_id, workspace_id, account_status, display_email, setup_completed, first_sign_in, analytics_alias_id, workspace_version
           from identity.provision_owner($1::uuid, $2, $3)`,
          [access.sub, parsedEmail.display, parsedEmail.normalized],
        );
        const provisioned = owner.rows[0];
        if (!provisioned) {
          return undefined;
        }
        if (provisioned.account_status === "suspended") {
          return { kind: "suspended" as const };
        }
        if (provisioned.account_status !== "active") {
          return { kind: "locked" as const };
        }
        const completed = await client.query<SetupRow>(
          `select actor_id, workspace_id, account_status, display_email, setup_completed, first_sign_in, analytics_alias_id, workspace_version, replayed
           from commercial.complete_workspace_setup(
             $1::uuid, $2::integer, $3::uuid, $4, $5::uuid,
             $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14::integer, $15::integer, $16
           )`,
          [
            provisioned.actor_id,
            expectedVersion,
            key,
            hash,
            request.id,
            parsed.value.business_name,
            parsed.value.legal_name,
            parsed.value.contact_name,
            parsed.value.contact_email,
            parsed.value.contact_phone,
            JSON.stringify(parsed.value.address),
            parsed.value.timezone,
            parsed.value.trade,
            parsed.value.default_tax_bp,
            parsed.value.default_due_days,
            parsed.value.default_terms,
          ],
        );
        return { kind: "ok" as const, row: completed.rows[0] };
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      }
      if (row.kind === "suspended") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_SUSPENDED, "This account cannot make changes.");
      }
      if (row.kind === "locked") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
      }
      if (!row.row) {
        return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      }
      return success(request.id, bootstrapFrom(row.row));
    } catch (error) {
      const code = pgCode(error);
      if (code === "P0001") {
        return sendFail(request, reply, API_ERROR_CODES.VERSION_CONFLICT, "This setup was updated elsewhere. Reload and try again.");
      }
      if (code === "P0004") {
        return sendFail(request, reply, API_ERROR_CODES.IDEMPOTENCY_MISMATCH, "Idempotency key was reused with a different body.");
      }
      if (code === "23514") {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.");
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });
}
