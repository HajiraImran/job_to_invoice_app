import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ACTION_GRANT_FRESH_AUTH_SECONDS,
  ACTION_GRANT_TTL_SECONDS,
  API_ERROR_CODES,
  parseActionGrantBody,
  parseOwnerEmail,
} from "@job-to-invoice/schemas";
import type { Pool } from "pg";
import { withApiRole } from "./db.ts";
import { fail, success } from "./envelope.ts";
import { bearerToken, JwtVerificationError, type JwtVerifier, type VerifiedAccess } from "./jwt.ts";

const GENERIC_AUTH = "Could not verify your session.";
const SIGN_IN_REQUIRED = "Sign in required.";
const FRESH_AUTH_REQUIRED = "Confirm it's you with a new verification code, then try again.";

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
  extra?: { field_errors?: { field: string; message: string }[] },
) {
  const result = fail(request.id, code, message, { field_errors: extra?.field_errors });
  return reply.status(result.status).send(result.body);
}

function isFreshAuth(access: VerifiedAccess, nowSec: number): boolean {
  if (typeof access.authTime !== "number" || !Number.isFinite(access.authTime)) {
    return false;
  }
  return nowSec - access.authTime <= ACTION_GRANT_FRESH_AUTH_SECONDS && access.authTime <= nowSec + 5;
}

export function registerActionGrantRoutes(
  app: FastifyInstance,
  deps: {
    verifyJwt?: JwtVerifier;
    pool?: Pool;
    nowSec?: () => number;
  },
  options: { limiterAllow: (key: string) => { ok: true } | { ok: false; retryAfterSec: number } },
): void {
  app.post("/v1/account/action-grants", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_REQUIRED, SIGN_IN_REQUIRED);
    }
    if (!deps.verifyJwt || !deps.pool) {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
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
    const nowSec = deps.nowSec?.() ?? Math.floor(Date.now() / 1000);
    if (!isFreshAuth(access, nowSec)) {
      return sendFail(request, reply, API_ERROR_CODES.ACTION_GRANT_REQUIRED, FRESH_AUTH_REQUIRED);
    }
    const parsed = parseActionGrantBody(request.body);
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    // This slice issues replace_link, export, and deletion. email_change remains deferred.
    if (
      parsed.value.action !== "replace_link" &&
      parsed.value.action !== "export" &&
      parsed.value.action !== "deletion"
    ) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "action", message: "This action is not available yet." }],
      });
    }

    const rawGrant = randomBytes(32);
    const tokenHash = createHash("sha256").update(rawGrant).digest();
    const expiresAt = new Date((nowSec + ACTION_GRANT_TTL_SECONDS) * 1000).toISOString();
    const grantPlain = rawGrant.toString("base64url");
    rawGrant.fill(0);

    try {
      const issued = await withApiRole(deps.pool, async (client) => {
        const owner = await client.query<ProvisionRow>(
          `select actor_id, workspace_id, account_status, display_email, setup_completed
           from identity.provision_owner($1::uuid, $2, $3)`,
          [access.sub, parsedEmail.display, parsedEmail.normalized],
        );
        const row = owner.rows[0];
        if (!row) {
          return { kind: "auth" as const };
        }
        if (row.account_status === "suspended") {
          return { kind: "suspended" as const };
        }
        if (row.account_status !== "active") {
          return { kind: "deleting" as const };
        }
        if (!row.setup_completed) {
          return { kind: "setup" as const };
        }
        await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [
          row.workspace_id,
          row.actor_id,
        ]);
        const inserted = await client.query<{ id: string; expires_at: Date | string; action: string }>(
          `insert into identity.action_grants (id, user_id, action, token_hash, expires_at)
           values (gen_random_uuid(), $1::uuid, $2, $3::bytea, $4::timestamptz)
           returning id, expires_at, action`,
          [row.actor_id, parsed.value.action, tokenHash, expiresAt],
        );
        return { kind: "ok" as const, row: inserted.rows[0] };
      });
      if (issued.kind === "auth") {
        return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      }
      if (issued.kind === "suspended") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_SUSPENDED, "This account cannot make changes.");
      }
      if (issued.kind === "deleting") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
      }
      if (issued.kind === "setup") {
        return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      }
      if (issued.kind !== "ok" || !issued.row) {
        return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
      }
      const expires =
        issued.row.expires_at instanceof Date
          ? issued.row.expires_at.toISOString()
          : new Date(issued.row.expires_at).toISOString();
      return reply.status(201).send(
        success(request.id, {
          grant: grantPlain,
          action: issued.row.action,
          expires_at: expires,
        }),
      );
    } catch {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });
}
