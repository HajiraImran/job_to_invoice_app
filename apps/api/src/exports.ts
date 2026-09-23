import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { API_ERROR_CODES, parseExportRequest, parseOwnerEmail } from "@job-to-invoice/schemas";
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

type ExportRow = {
  id: string;
  workspace_id: string;
  status: string;
  cutoff_at: Date | string;
  created_at: Date | string;
  download_until: Date | string | null;
  delete_after: Date | string | null;
  ready_at: Date | string | null;
  schema_version: number;
  part_count: number;
  job_count: number | null;
  bytes: string | number | null;
  sha256: string | null;
  object_key?: string | null;
  download_available?: boolean;
  reused?: boolean;
  replayed?: boolean;
  manifest_json: unknown;
  error_code: string | null;
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

function exportBody(row: ExportRow) {
  return {
    id: row.id,
    status: row.status,
    cutoff_at: asIso(row.cutoff_at),
    created_at: asIso(row.created_at),
    download_until: asIso(row.download_until),
    delete_after: asIso(row.delete_after),
    ready_at: asIso(row.ready_at),
    schema_version: Number(row.schema_version),
    part_count: Number(row.part_count),
    job_count: row.job_count === null || row.job_count === undefined ? null : Number(row.job_count),
    bytes: row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
    sha256: row.sha256,
    download_available: row.download_available === true,
    reused: row.reused === true,
    manifest: row.manifest_json ?? null,
    error_code: row.error_code,
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

export function registerExportRoutes(
  app: FastifyInstance,
  deps: {
    verifyJwt?: JwtVerifier;
    pool?: Pool;
    documentsStore?: { presignGet: (key: string, expiresIn?: number) => Promise<string> };
  },
  options: { limiterAllow: (key: string) => { ok: true } | { ok: false; retryAfterSec: number } },
): void {
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
    if (owner.account_status !== "active") {
      sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
      return undefined;
    }
    if (!owner.setup_completed) {
      sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      return undefined;
    }
    return owner;
  }

  function mapExportError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
    const code = pgCode(error);
    if (code === "P0004") {
      return sendFail(request, reply, API_ERROR_CODES.IDEMPOTENCY_MISMATCH, "Idempotency key was reused with a different body.");
    }
    if (code === "P0003") {
      return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
    }
    if (code === "P0005") {
      return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, "Export is not available.");
    }
    if (code === "P0041") {
      return sendFail(request, reply, API_ERROR_CODES.ACTION_GRANT_INVALID, "Confirm it's you again, then retry.");
    }
    if (code === "P0042") {
      return sendFail(request, reply, API_ERROR_CODES.ACTION_GRANT_REQUIRED, "Confirm it's you again, then retry.");
    }
    if (code === "P0058") {
      return sendFail(request, reply, API_ERROR_CODES.EXPORT_LIMIT, "You can create two new exports per day. Reuse today's bundle or try again tomorrow.");
    }
    if (code === "22023") {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.");
    }
    return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
  }

  app.post("/v1/exports", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    const parsed = parseExportRequest(request.body);
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
    const hash = requestHash({ action: "export", newer: parsed.value.newer });
    try {
      const row = await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        const result = await client.query<ExportRow>(
          `select id, workspace_id, status, cutoff_at, created_at, download_until, delete_after, ready_at,
                  schema_version, part_count, job_count, bytes, sha256, reused, replayed, manifest_json, error_code
           from commercial.request_export($1::uuid, $2::uuid, $3, $4::uuid, $5::bytea, $6::boolean)`,
          [owner.actor_id, key, hash, request.id, grantHash, parsed.value.newer],
        );
        return result.rows[0];
      });
      if (!row) {
        return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
      }
      return reply.status(202).send(success(request.id, exportBody(row)));
    } catch (error) {
      return mapExportError(request, reply, error);
    }
  });

  app.get("/v1/exports/latest", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    try {
      const row = await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        const result = await client.query<ExportRow>(
          `select id, workspace_id, status, cutoff_at, created_at, download_until, delete_after, ready_at,
                  schema_version, part_count, job_count, bytes, sha256, object_key, download_available,
                  manifest_json, error_code
           from commercial.latest_export($1::uuid)`,
          [owner.actor_id],
        );
        return result.rows[0];
      });
      if (!row) {
        return success(request.id, { export: null });
      }
      return success(request.id, { export: exportBody(row) });
    } catch (error) {
      return mapExportError(request, reply, error);
    }
  });

  app.get("/v1/exports/:exportId", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    const params = request.params as { exportId?: string };
    if (!params.exportId || !UUID.test(params.exportId)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "exportId", message: "A export UUID is required." }],
      });
    }
    try {
      const row = await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        const result = await client.query<ExportRow>(
          `select id, workspace_id, status, cutoff_at, created_at, download_until, delete_after, ready_at,
                  schema_version, part_count, job_count, bytes, sha256, object_key, download_available,
                  manifest_json, error_code
           from commercial.get_export($1::uuid, $2::uuid)`,
          [owner.actor_id, params.exportId],
        );
        return result.rows[0];
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, "Export is not available.");
      }
      return success(request.id, exportBody(row));
    } catch (error) {
      return mapExportError(request, reply, error);
    }
  });

  app.get("/v1/exports/:exportId/download", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    const params = request.params as { exportId?: string };
    if (!params.exportId || !UUID.test(params.exportId)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "exportId", message: "A export UUID is required." }],
      });
    }
    if (!deps.documentsStore) {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
    try {
      const row = await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        const result = await client.query<ExportRow>(
          `select id, workspace_id, status, cutoff_at, created_at, download_until, delete_after, ready_at,
                  schema_version, part_count, job_count, bytes, sha256, object_key, download_available,
                  manifest_json, error_code
           from commercial.get_export($1::uuid, $2::uuid)`,
          [owner.actor_id, params.exportId],
        );
        return result.rows[0];
      });
      if (!row || !row.object_key || row.download_available !== true) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, "This download is no longer available.");
      }
      const until = row.download_until ? new Date(row.download_until).getTime() : Date.now();
      const remaining = Math.max(1, Math.floor((until - Date.now()) / 1000));
      const url = await deps.documentsStore.presignGet(row.object_key, remaining);
      return success(request.id, {
        url,
        expires_at: asIso(row.download_until),
        sha256: row.sha256,
        bytes: row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
      });
    } catch (error) {
      return mapExportError(request, reply, error);
    }
  });
}
