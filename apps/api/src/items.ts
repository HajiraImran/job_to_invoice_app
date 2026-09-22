import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  isClientUuid,
  parseCatalogueItemCreate,
  parseCatalogueItemPatch,
  parseItemArchive,
  parseItemListQuery,
  parseOwnerEmail,
  type ItemListState,
} from "@job-to-invoice/schemas";
import type { Pool } from "pg";
import { withApiRole, withTenant } from "./db.ts";
import { API_ERROR_CODES, fail, success } from "./envelope.ts";
import { bearerToken, JwtVerificationError, type JwtVerifier, type VerifiedAccess } from "./jwt.ts";

const GENERIC_AUTH = "Could not verify your session.";
const SIGN_IN_REQUIRED = "Sign in required.";
const ITEM_NOT_FOUND = "Item was not found.";
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

type ItemRow = {
  id: string;
  workspace_id: string;
  description: string;
  unit: string;
  custom_unit_label: string | null;
  default_quantity: string | number;
  unit_price_cents: string | number;
  discount_cents: string | number;
  tax_bp: number;
  archived_at: Date | string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  replayed?: boolean;
};

type ItemCursor = { u: string; i: string; s: string | null; t: ItemListState };

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

function cents(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function quantityString(value: string | number): string {
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/\.?0+$/, "");
  }
  if (/^\d+$/.test(value)) {
    return value;
  }
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export function encodeItemCursor(payload: ItemCursor): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeItemCursor(raw: string): ItemCursor | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.u !== "string" || !isClientUuid(record.i)) {
      return undefined;
    }
    if (record.s !== null && typeof record.s !== "string") {
      return undefined;
    }
    if (record.t !== "active" && record.t !== "archived" && record.t !== "all") {
      return undefined;
    }
    return { u: record.u, i: record.i, s: record.s, t: record.t };
  } catch {
    return undefined;
  }
}

function escapeIlike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export function presentCatalogueItem(row: ItemRow) {
  return {
    id: row.id,
    description: row.description,
    unit: row.unit,
    custom_unit_label: row.custom_unit_label,
    default_quantity: quantityString(row.default_quantity),
    unit_price_cents: cents(row.unit_price_cents),
    discount_cents: cents(row.discount_cents),
    tax_bp: row.tax_bp,
    archived_at: row.archived_at ? asIso(row.archived_at) : null,
    version: row.version,
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
  };
}

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
  if (row.account_status === "suspended") {
    return "suspended";
  }
  if (row.account_status !== "active") {
    return "locked";
  }
  if (!row.setup_completed) {
    return "setup";
  }
  return "ok";
}

export function registerItemRoutes(
  app: FastifyInstance,
  deps: { verifyJwt?: JwtVerifier; pool?: Pool },
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

  app.get("/v1/items", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    const queryRecord: Record<string, unknown> = {};
    const rawQuery = request.query as Record<string, unknown>;
    for (const key of Object.keys(rawQuery ?? {})) {
      queryRecord[key] = firstQuery(rawQuery[key]);
    }
    const parsed = parseItemListQuery(queryRecord);
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    let cursor: ItemCursor | undefined;
    if (parsed.value.cursor) {
      cursor = decodeItemCursor(parsed.value.cursor);
      if (!cursor || cursor.s !== parsed.value.search || cursor.t !== parsed.value.state) {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
          field_errors: [{ field: "cursor", message: "Enter a valid value." }],
        });
      }
    }
    try {
      const rows = await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        const result = await client.query<ItemRow>(
          `select id, workspace_id, description, unit, custom_unit_label, default_quantity,
                  unit_price_cents, discount_cents, tax_bp, archived_at, version, created_at, updated_at
           from commercial.catalogue_items
           where (
             ($1 = 'all')
             or ($1 = 'active' and archived_at is null)
             or ($1 = 'archived' and archived_at is not null)
           )
             and (
               $2::text is null
               or description ilike '%' || $2 || '%' escape chr(92)
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
          ? encodeItemCursor({
              u: asIso(last.updated_at),
              i: last.id,
              s: parsed.value.search,
              t: parsed.value.state,
            })
          : null;
      return success(request.id, { items: page.map(presentCatalogueItem), next_cursor });
    } catch {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.post("/v1/items", async (request, reply) => {
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
    const parsed = parseCatalogueItemCreate(body);
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    const hash = requestHash(body);
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
        if (!provisioned.setup_completed) {
          return { kind: "setup" as const };
        }
        const created = await client.query<ItemRow>(
          `select id, workspace_id, description, unit, custom_unit_label, default_quantity,
                  unit_price_cents, discount_cents, tax_bp, archived_at, version, created_at, updated_at, replayed
           from commercial.create_catalogue_item(
             $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid,
             $6, $7, $8, $9::numeric, $10::bigint, $11::bigint, $12::integer
           )`,
          [
            provisioned.actor_id,
            key,
            hash,
            request.id,
            parsed.value.id,
            parsed.value.description,
            parsed.value.unit,
            parsed.value.custom_unit_label,
            parsed.value.default_quantity,
            parsed.value.unit_price_cents,
            parsed.value.discount_cents,
            parsed.value.tax_bp,
          ],
        );
        return { kind: "ok" as const, row: created.rows[0] };
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
      return success(request.id, presentCatalogueItem(row.row));
    } catch (error) {
      const code = pgCode(error);
      if (code === "P0004") {
        return sendFail(request, reply, API_ERROR_CODES.IDEMPOTENCY_MISMATCH, "Idempotency key was reused with a different body.");
      }
      if (code === "P0003") {
        return sendFail(request, reply, API_ERROR_CODES.SETUP_INCOMPLETE, "Complete business setup first.");
      }
      if (code === "23505") {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
          field_errors: [{ field: "id", message: "This item id is already used." }],
        });
      }
      if (code === "23514" || code === "22023") {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.");
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.get("/v1/items/:itemId", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    const itemId = (request.params as { itemId?: string }).itemId;
    if (!itemId || !UUID.test(itemId)) {
      return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, ITEM_NOT_FOUND);
    }
    try {
      const row = await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        const result = await client.query<ItemRow>(
          `select id, workspace_id, description, unit, custom_unit_label, default_quantity,
                  unit_price_cents, discount_cents, tax_bp, archived_at, version, created_at, updated_at
           from commercial.catalogue_items
           where id = $1`,
          [itemId],
        );
        return result.rows[0];
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, ITEM_NOT_FOUND);
      }
      return success(request.id, presentCatalogueItem(row));
    } catch {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.patch("/v1/items/:itemId", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    const itemId = (request.params as { itemId?: string }).itemId;
    if (!itemId || !UUID.test(itemId)) {
      return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, ITEM_NOT_FOUND);
    }
    const version = ifMatchVersion(request);
    if (version === undefined) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "If-Match version is required.", {
        field_errors: [{ field: "If-Match", message: "Current version is required." }],
      });
    }
    const body = request.body === undefined || request.body === null ? {} : request.body;
    const parsed = parseCatalogueItemPatch(body);
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    try {
      const row = await withApiRole(deps.pool, async (client) => {
        const result = await client.query<ItemRow>(
          `select id, workspace_id, description, unit, custom_unit_label, default_quantity,
                  unit_price_cents, discount_cents, tax_bp, archived_at, version, created_at, updated_at
           from commercial.save_catalogue_item(
             $1::uuid, $2::uuid, $3::integer, $4, $5, $6, $7::numeric, $8::bigint, $9::bigint, $10::integer
           )`,
          [
            owner.actor_id,
            itemId,
            version,
            parsed.value.description,
            parsed.value.unit,
            parsed.value.custom_unit_label,
            parsed.value.default_quantity,
            parsed.value.unit_price_cents,
            parsed.value.discount_cents,
            parsed.value.tax_bp,
          ],
        );
        return result.rows[0];
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, ITEM_NOT_FOUND);
      }
      return success(request.id, presentCatalogueItem(row));
    } catch (error) {
      const code = pgCode(error);
      if (code === "P0005") {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, ITEM_NOT_FOUND);
      }
      if (code === "P0001") {
        return sendFail(request, reply, API_ERROR_CODES.VERSION_CONFLICT, "This item changed. Refresh and try again.");
      }
      if (code === "23514" || code === "22023") {
        return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.");
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  app.post("/v1/items/:itemId/archive", async (request, reply) => {
    const owner = await requireOwner(request, reply);
    if (!owner || !deps.pool) {
      return;
    }
    const itemId = (request.params as { itemId?: string }).itemId;
    if (!itemId || !UUID.test(itemId)) {
      return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, ITEM_NOT_FOUND);
    }
    const version = ifMatchVersion(request);
    if (version === undefined) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "If-Match version is required.", {
        field_errors: [{ field: "If-Match", message: "Current version is required." }],
      });
    }
    const body = request.body === undefined || request.body === null ? {} : request.body;
    const parsed = parseItemArchive(body);
    if (!parsed.ok) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Check the highlighted fields.", {
        field_errors: parsed.field_errors,
      });
    }
    try {
      const row = await withApiRole(deps.pool, async (client) => {
        const result = await client.query<ItemRow>(
          `select id, workspace_id, description, unit, custom_unit_label, default_quantity,
                  unit_price_cents, discount_cents, tax_bp, archived_at, version, created_at, updated_at
           from commercial.archive_catalogue_item($1::uuid, $2::uuid, $3::integer, $4::boolean)`,
          [owner.actor_id, itemId, version, parsed.value.archived],
        );
        return result.rows[0];
      });
      if (!row) {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, ITEM_NOT_FOUND);
      }
      return success(request.id, presentCatalogueItem(row));
    } catch (error) {
      const code = pgCode(error);
      if (code === "P0005") {
        return sendFail(request, reply, API_ERROR_CODES.NOT_FOUND, ITEM_NOT_FOUND);
      }
      if (code === "P0001") {
        return sendFail(request, reply, API_ERROR_CODES.VERSION_CONFLICT, "This item changed. Refresh and try again.");
      }
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });
}
