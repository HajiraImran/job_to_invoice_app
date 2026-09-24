import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  isClientUuid,
  parseCustomerArchive,
  parseCustomerCreate,
  parseCustomerListQuery,
  parseCustomerPatch,
  parseEmptyObjectBody,
  parseOwnerEmail,
  type CustomerListState,
} from "@job-to-invoice/schemas";
import type { Pool } from "pg";
import { withApiRole, withTenant } from "./db.ts";
import { API_ERROR_CODES, fail, success } from "./envelope.ts";
import { bearerToken, JwtVerificationError, type JwtVerifier, type VerifiedAccess } from "./jwt.ts";

const GENERIC_AUTH = "Could not verify your session.";
const SIGN_IN_REQUIRED = "Sign in required.";
const CUSTOMER_NOT_FOUND = "Customer was not found.";
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

type CustomerRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  billing_address_json: Record<string, unknown> | null;
  archived_at: Date | string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  replayed?: boolean;
};

type CustomerCursor = { u: string; i: string; s: string | null; t: CustomerListState };

type DuplicateRow = { id: string; name: string; archived: boolean };

function sendFail(
  request: FastifyRequest,
  reply: FastifyReply,
  code: string,
  message: string,
  extra?: {
    field_errors?: { field: string; message: string }[];
    duplicates?: DuplicateRow[];
  },
) {
  const result = fail(request.id, code, message, {
    field_errors: extra?.field_errors,
    duplicates: extra?.duplicates,
  });
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

function requestHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function pgCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

function asIso(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(value).toISOString();
}

function firstQuery(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function escapeIlike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export function presentCustomer(row: CustomerRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    billing_address: row.billing_address_json,
    archived_at: row.archived_at ? asIso(row.archived_at) : null,
    version: row.version,
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
  };
}

export function encodeCustomerCursor(payload: CustomerCursor): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCustomerCursor(value: string): CustomerCursor | undefined {
  try {
    const raw = Buffer.from(value, "base64url").toString("utf8");
    const record = JSON.parse(raw) as Partial<CustomerCursor>;
    if (typeof record.u !== "string" || !isClientUuid(record.i)) {
      return undefined;
    }
    if (record.s !== null && typeof record.s !== "string") {
      return undefined;
    }
    if (record.t !== "active" && record.t !== "archived" && record.t !== "all") {
      return undefined;
    }
    return { u: record.u, i: record.i, s: record.s ?? null, t: record.t };
  } catch {
    return undefined;
  }
}

const CUSTOMER_COLUMNS = `id, name, email, phone, billing_address_json, archived_at, version, created_at, updated_at`;

async function provisionOwner(pool: Pool, access: VerifiedAccess): Promise<ProvisionRow | undefined> {
  const parsedEmail = parseOwnerEmail(access.email);
  if (!parsedEmail.ok) {
    return undefined;
  }
  return withApiRole(pool, async (client) => {
    const result = await client.query<ProvisionRow>(
      `select actor_id, workspace_id, account_status, display_email, setup_completed, first_sign_in, analytics_alias_id, workspace_version
       from identity.provision_owner($1::uuid, $2, $3)`,
      [access.sub, parsedEmail.display, parsedEmail.normalized],
    );
    return result.rows[0];
  });
}

function accountGate(row: ProvisionRow): "ok" | "suspended" | "locked" | "setup" {
  if (row.account_status === "suspended") return "suspended";
  if (row.account_status !== "active") return "locked";
  if (!row.setup_completed) return "setup";
  return "ok";
}

async function loadDuplicates(
  pool: Pool,
  owner: ProvisionRow,
  normalizedEmail: string,
  excludeId: string | null,
): Promise<DuplicateRow[]> {
  return withTenant(pool, owner.workspace_id, owner.actor_id, async (client) => {
    const result = await client.query<DuplicateRow>(
      `select id, name, (archived_at is not null) as archived
       from commercial.customers
       where normalized_email = $1
         and ($2::uuid is null or id <> $2::uuid)
       order by name, id`,
      [normalizedEmail, excludeId],
    );
    return result.rows.map((row) => ({ id: row.id, name: row.name, archived: row.archived }));
  });
}

export function registerCustomerRoutes(
  app: FastifyInstance,
  deps: { pool?: Pool; verifyJwt?: JwtVerifier },
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
    const gate = accountGate(owner);
    if (gate === "suspended") {
      sendFail(request, reply, API_ERROR_CODES.ACCOUNT_SUSPENDED, "This account cannot make changes.");
      return undefined;
    }
    if (gate === "locked") {
      sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
      return undefined;
    }
    if (gate === "setup") {
      sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      return undefined;
    }
    return owner;
  }

  function mutationError(
    request: FastifyRequest,
    reply: FastifyReply,
    error: unknown,
    duplicates?: DuplicateRow[],
  ) {
    const code = pgCode(error);
    if (code === "P0004") {
      return sendFail(request, reply, API_ERROR_CODES.IDEMPOTENCY_MISMATCH, "Idempotency key was reused with a different body.");
    }
    if (code === "P0003") {
      return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
    }
    if (code === "P0001") {
      return sendFail(request, reply, API_ERROR_CODES.VERSION_CONFLICT, "This customer changed. Refresh and try again.");
    }
    if (code === "P0005") {
      return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, CUSTOMER_NOT_FOUND);
    }
    if (code === "P0060") {
      return sendFail(
        request,
        reply,
        API_ERROR_CODES.DUPLICATE_CUSTOMER_EMAIL,
        "A customer with this email already exists. Confirm to continue.",
        { duplicates },
      );
    }
    if (code === "P0061") {
      return sendFail(
        request,
        reply,
        API_ERROR_CODES.CUSTOMER_REFERENCED,
        "This customer has jobs. Archive the customer instead.",
      );
    }
    if (code === "23505") {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: [{ field: "id", message: "This customer id is already used." }],
      });
    }
    if (code === "23514" || code === "22023") {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.");
    }
    if (code === "42501") {
      return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
    }
    return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
  }

  app.get("/v1/customers", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    const queryRecord: Record<string, unknown> = {};
    const rawQuery = request.query as Record<string, unknown>;
    for (const key of Object.keys(rawQuery ?? {})) {
      queryRecord[key] = firstQuery(rawQuery[key]);
    }
    const parsed = parseCustomerListQuery(queryRecord);
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    let cursor: CustomerCursor | undefined;
    if (parsed.value.cursor) {
      cursor = decodeCustomerCursor(parsed.value.cursor);
      if (!cursor || cursor.s !== parsed.value.search || cursor.t !== parsed.value.state) {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
          field_errors: [{ field: "cursor", message: "Enter a valid value." }],
        });
      }
    }
    try {
      const rows = await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        const result = await client.query<CustomerRow>(
          `select ${CUSTOMER_COLUMNS}
           from commercial.customers
           where (
             ($1 = 'all')
             or ($1 = 'active' and archived_at is null)
             or ($1 = 'archived' and archived_at is not null)
           )
             and (
               $2::text is null
               or name ilike '%' || $2 || '%' escape chr(92)
               or email ilike '%' || $2 || '%' escape chr(92)
               or normalized_email ilike '%' || $2 || '%' escape chr(92)
             )
             and (
               $3::timestamptz is null
               or (updated_at, id) < ($3::timestamptz, $4::uuid)
             )
           order by updated_at desc, id desc
           limit $5`,
          [
            parsed.value.state,
            parsed.value.search ? escapeIlike(parsed.value.search) : null,
            cursor?.u ?? null,
            cursor?.i ?? null,
            parsed.value.limit + 1,
          ],
        );
        return result.rows;
      });
      const hasMore = rows.length > parsed.value.limit;
      const page = hasMore ? rows.slice(0, parsed.value.limit) : rows;
      const last = page[page.length - 1];
      const next_cursor =
        hasMore && last
          ? encodeCustomerCursor({
              u: asIso(last.updated_at),
              i: last.id,
              s: parsed.value.search,
              t: parsed.value.state,
            })
          : null;
      return success(request.id, { customers: page.map(presentCustomer), next_cursor });
    } catch {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.get("/v1/customers/:customerId", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    const customerId = (request.params as { customerId?: string }).customerId;
    if (!customerId || !UUID.test(customerId)) {
      return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, CUSTOMER_NOT_FOUND);
    }
    try {
      const row = await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        const result = await client.query<CustomerRow>(
          `select ${CUSTOMER_COLUMNS} from commercial.customers where id = $1`,
          [customerId],
        );
        return result.rows[0];
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, CUSTOMER_NOT_FOUND);
      }
      return success(request.id, presentCustomer(row));
    } catch {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.post("/v1/customers", async (request, reply) => {
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
    let access: VerifiedAccess;
    try {
      access = await deps.verifyJwt(token);
    } catch {
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
    const parsed = parseCustomerCreate(body);
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    const hash = requestHash(body);
    const customerId = parsed.value.id ?? randomUUID();
    try {
      const row = await withApiRole(deps.pool, async (client) => {
        const owner = await client.query<ProvisionRow>(
          `select actor_id, workspace_id, account_status, display_email, setup_completed, first_sign_in, analytics_alias_id, workspace_version
           from identity.provision_owner($1::uuid, $2, $3)`,
          [access.sub, parsedEmail.display, parsedEmail.normalized],
        );
        const provisioned = owner.rows[0];
        if (!provisioned) return undefined;
        if (provisioned.account_status === "suspended") return { kind: "suspended" as const };
        if (provisioned.account_status !== "active") return { kind: "locked" as const };
        if (!provisioned.setup_completed) return { kind: "setup" as const };
        await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [
          provisioned.workspace_id,
          provisioned.actor_id,
        ]);
        const created = await client.query<CustomerRow>(
          `select ${CUSTOMER_COLUMNS}, replayed
           from commercial.create_customer(
             $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid,
             $6, $7, $8, $9, $10::jsonb, $11::boolean
           )`,
          [
            provisioned.actor_id,
            key,
            hash,
            request.id,
            customerId,
            parsed.value.name,
            parsed.value.email,
            parsed.value.normalized_email,
            parsed.value.phone,
            parsed.value.billing_address ? JSON.stringify(parsed.value.billing_address) : null,
            parsed.value.confirm_duplicate_email,
          ],
        );
        return { kind: "ok" as const, row: created.rows[0], owner: provisioned };
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
      if (row.kind === "setup") {
        return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      }
      if (!row.row) {
        return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      }
      return success(request.id, presentCustomer(row.row));
    } catch (error) {
      if (pgCode(error) === "P0060" && parsed.value.normalized_email && deps.pool) {
        try {
          const owner = await provisionOwner(deps.pool, access);
          const duplicates =
            owner && accountGate(owner) === "ok"
              ? await loadDuplicates(deps.pool, owner, parsed.value.normalized_email, null)
              : [];
          return mutationError(request, reply, error, duplicates);
        } catch {
          return mutationError(request, reply, error, []);
        }
      }
      return mutationError(request, reply, error);
    }
  });

  app.patch("/v1/customers/:customerId", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    const customerId = (request.params as { customerId?: string }).customerId;
    if (!customerId || !UUID.test(customerId)) {
      return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, CUSTOMER_NOT_FOUND);
    }
    const version = ifMatchVersion(request);
    if (!version) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "If-Match version is required.", {
        field_errors: [{ field: "If-Match", message: "Version required" }],
      });
    }
    const key = idempotencyKey(request);
    if (!key || !UUID.test(key)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Idempotency-Key UUID is required.", {
        field_errors: [{ field: "Idempotency-Key", message: "UUID required" }],
      });
    }
    const body = request.body === undefined || request.body === null ? {} : request.body;
    const parsed = parseCustomerPatch(body);
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    const hash = requestHash({ body, if_match: version });
    const setName = Object.prototype.hasOwnProperty.call(parsed.value, "name");
    const setEmail = Object.prototype.hasOwnProperty.call(parsed.value, "email");
    const setPhone = Object.prototype.hasOwnProperty.call(parsed.value, "phone");
    const setAddress = Object.prototype.hasOwnProperty.call(parsed.value, "billing_address");
    try {
      const updated = await withApiRole(deps.pool, async (client) => {
        await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [
          owner.workspace_id,
          owner.actor_id,
        ]);
        const result = await client.query<CustomerRow>(
          `select ${CUSTOMER_COLUMNS}, replayed
           from commercial.update_customer(
             $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::integer,
             $7::boolean, $8, $9::boolean, $10, $11,
             $12::boolean, $13, $14::boolean, $15::jsonb, $16::boolean
           )`,
          [
            owner.actor_id,
            key,
            hash,
            request.id,
            customerId,
            version,
            setName,
            setName ? parsed.value.name : null,
            setEmail,
            setEmail ? parsed.value.email : null,
            setEmail ? parsed.value.normalized_email : null,
            setPhone,
            setPhone ? parsed.value.phone : null,
            setAddress,
            setAddress && parsed.value.billing_address ? JSON.stringify(parsed.value.billing_address) : null,
            parsed.value.confirm_duplicate_email,
          ],
        );
        return result.rows[0];
      });
      if (!updated) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, CUSTOMER_NOT_FOUND);
      }
      return success(request.id, presentCustomer(updated));
    } catch (error) {
      if (pgCode(error) === "P0060" && setEmail && parsed.value.normalized_email) {
        try {
          const duplicates = await loadDuplicates(deps.pool, owner, parsed.value.normalized_email, customerId);
          return mutationError(request, reply, error, duplicates);
        } catch {
          return mutationError(request, reply, error, []);
        }
      }
      return mutationError(request, reply, error);
    }
  });

  app.post("/v1/customers/:customerId/archive", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    const customerId = (request.params as { customerId?: string }).customerId;
    if (!customerId || !UUID.test(customerId)) {
      return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, CUSTOMER_NOT_FOUND);
    }
    const key = idempotencyKey(request);
    if (!key || !UUID.test(key)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Idempotency-Key UUID is required.", {
        field_errors: [{ field: "Idempotency-Key", message: "UUID required" }],
      });
    }
    const body = request.body === undefined || request.body === null ? {} : request.body;
    const parsed = parseCustomerArchive(body);
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    const hash = requestHash(body);
    try {
      const updated = await withApiRole(deps.pool, async (client) => {
        await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [
          owner.workspace_id,
          owner.actor_id,
        ]);
        const result = await client.query<CustomerRow>(
          `select ${CUSTOMER_COLUMNS}, replayed
           from commercial.archive_customer($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::boolean)`,
          [owner.actor_id, key, hash, request.id, customerId, parsed.value.archived],
        );
        return result.rows[0];
      });
      if (!updated) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, CUSTOMER_NOT_FOUND);
      }
      return success(request.id, presentCustomer(updated));
    } catch (error) {
      return mutationError(request, reply, error);
    }
  });

  app.delete("/v1/customers/:customerId", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    const customerId = (request.params as { customerId?: string }).customerId;
    if (!customerId || !UUID.test(customerId)) {
      return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, CUSTOMER_NOT_FOUND);
    }
    const empty = parseEmptyObjectBody(request.body);
    if (!empty.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: empty.field_errors,
      });
    }
    const key = idempotencyKey(request);
    if (!key || !UUID.test(key)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Idempotency-Key UUID is required.", {
        field_errors: [{ field: "Idempotency-Key", message: "UUID required" }],
      });
    }
    const hash = requestHash({ customer_id: customerId, action: "delete" });
    try {
      const deleted = await withApiRole(deps.pool, async (client) => {
        await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [
          owner.workspace_id,
          owner.actor_id,
        ]);
        const result = await client.query<{ deleted: boolean; replayed: boolean }>(
          `select deleted, replayed
           from commercial.delete_customer($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid)`,
          [owner.actor_id, key, hash, request.id, customerId],
        );
        return result.rows[0];
      });
      if (!deleted) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, CUSTOMER_NOT_FOUND);
      }
      return success(request.id, { deleted: deleted.deleted });
    } catch (error) {
      return mutationError(request, reply, error);
    }
  });
}
