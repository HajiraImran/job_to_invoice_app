import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { LoadedApiEnv, LoadedEnv } from "@job-to-invoice/config";
import {
  ANALYTICS_SCHEMA_VERSION,
  analyticsPropertiesAreSafe,
  isClientAnalyticsEvent,
  parseOwnerEmail,
  publicSupportUrl,
} from "@job-to-invoice/schemas";
import type { Pool } from "pg";
import { withApiRole, withTenant, ApiTransactionError } from "./db.ts";
import { API_ERROR_CODES, fail, requestId, success } from "./envelope.ts";
import { bearerToken, type JwtVerifier, type VerifiedAccess } from "./jwt.ts";
import {
  allowlistedSqlstate,
  ownerMeSafeEvent,
  writeOwnerMeEvent,
  type OwnerMeSafeEvent,
  type OwnerMeStage,
} from "./me-log.ts";
import type { QuotePublishSafeEvent } from "./publish-log.ts";
import { registerChangeRoutes } from "./changes.ts";
import { registerDraftRoutes } from "./drafts.ts";
import { registerCustomerRoutes } from "./customers.ts";
import { registerItemRoutes } from "./items.ts";
import { registerJobRoutes } from "./jobs.ts";
import { registerQuotePublishRoutes } from "./quotes.ts";
import { registerInvoiceRoutes } from "./invoices.ts";
import { registerEmailWebhookRoutes } from "./webhooks-email.ts";
import { registerPortalRoutes } from "./portal.ts";
import { registerActionGrantRoutes } from "./action-grants.ts";
import { registerRequestMutationRoutes } from "./requests.ts";
import { RateLimiter } from "./rate-limit.ts";
import {
  apiRequestEvent,
  clientRequestId,
  createRequestTiming,
  runWithRequestTiming,
  serverTimingHeader,
  type ApiRequestEvent,
  type RequestTiming,
} from "./request-context.ts";
import { registerSubscriptionRoutes } from "./subscription.ts";
import { registerExportRoutes } from "./exports.ts";
import { registerDeletionRoutes } from "./deletion.ts";
import { registerSupportRoutes } from "./support.ts";
import { registerWorkspaceRoutes } from "./workspace.ts";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
    timing?: RequestTiming;
  }
}

export type AppDeps = {
  env: LoadedEnv | LoadedApiEnv;
  verifyJwt?: JwtVerifier;
  pool?: Pool;
  logOwnerMe?: (event: OwnerMeSafeEvent) => void;
  logQuotePublish?: (event: QuotePublishSafeEvent) => void;
  logPortal?: (event: { event: "portal"; request_id: string; status: number; stage: string; sqlstate?: string }) => void;
  documentsStore?: { presignGet: (key: string, expiresIn?: number) => Promise<string> };
  nowSec?: () => number;
  logRequest?: (event: ApiRequestEvent) => void;
};

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

const GENERIC_AUTH = "Could not verify your session.";
const SIGN_IN_REQUIRED = "Sign in required.";

function isUsableProvisionRow(row: ProvisionRow | undefined): row is ProvisionRow {
  if (!row) {
    return false;
  }
  return (
    typeof row.actor_id === "string" &&
    row.actor_id.length > 0 &&
    typeof row.workspace_id === "string" &&
    row.workspace_id.length > 0 &&
    typeof row.account_status === "string" &&
    typeof row.display_email === "string" &&
    typeof row.setup_completed === "boolean" &&
    typeof row.first_sign_in === "boolean" &&
    typeof row.analytics_alias_id === "string" &&
    typeof row.workspace_version === "number"
  );
}

function ownerMeDatabaseStage(error: unknown): OwnerMeStage {
  if (error instanceof ApiTransactionError) {
    if (error.stage === "session_query_failed") {
      return "provision_owner_failed";
    }
    if (error.stage === "tenant_context_failed") {
      return "database_or_provisioning_failed";
    }
    return error.stage;
  }
  return "database_or_provisioning_failed";
}

function ownerMeSqlstate(error: unknown): string | undefined {
  if (error instanceof ApiTransactionError) {
    return allowlistedSqlstate(error.sqlstate);
  }
  return undefined;
}

function sendFail(
  request: FastifyRequest,
  reply: FastifyReply,
  code: string,
  message: string,
  extra?: { field_errors?: { field: string; message: string }[]; retryAfter?: number },
) {
  const result = fail(request.id, code, message, { field_errors: extra?.field_errors });
  if (extra?.retryAfter !== undefined) {
    void reply.header("Retry-After", String(extra.retryAfter));
  }
  return reply.status(result.status).send(result.body);
}

async function readJson(request: FastifyRequest): Promise<unknown> {
  if (request.body === undefined || request.body === null) {
    return {};
  }
  return request.body;
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const raw = request.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: false, genReqId: requestId, bodyLimit: 1_048_576 });
  const limiter = new RateLimiter(120, 60_000);
  const idempotency = new Map<string, { hash: string; status: number; body: unknown }>();

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const path = request.url.split("?")[0];
    if (path === "/webhooks/email") {
      request.rawBody = raw;
      done(null, null);
      return;
    }
    if (raw.byteLength === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw.toString("utf8")) as unknown);
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.addHook("onRequest", (request, _reply, done) => {
    const timing = createRequestTiming();
    request.timing = timing;
    runWithRequestTiming(timing, done);
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (request.timing) {
      void reply.header("Server-Timing", serverTimingHeader(request.timing));
    }
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    if (!request.timing || !deps.logRequest) {
      return;
    }
    const event = apiRequestEvent({
      requestId: String(request.id),
      clientRequestId: clientRequestId(request.headers["x-client-request-id"]),
      method: request.method,
      route: request.routeOptions.url ?? "unmatched",
      status: reply.statusCode,
      timing: request.timing,
    });
    deps.logRequest(event);
  });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && origin !== deps.env.PORTAL_ORIGIN) {
      return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
    }
    if (origin) {
      void reply.header("Access-Control-Allow-Origin", origin);
      void reply.header("Vary", "Origin");
    }
    return undefined;
  });

  app.setErrorHandler((_error, request, reply) => {
    return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
  });

  app.get("/v1/health", async (request) =>
    success(request.id, {
      status: "ok",
      auth_configured: Boolean(deps.verifyJwt && deps.pool),
    }),
  );

  app.get("/v1/me", async (request, reply) => {
    const emit = (status: number, stage: OwnerMeStage, sqlstate?: string) => {
      try {
        const event = ownerMeSafeEvent({ request_id: String(request.id), status, stage, sqlstate });
        if (deps.logOwnerMe) {
          deps.logOwnerMe(event);
        } else {
          writeOwnerMeEvent(event);
        }
      } catch {
        /* diagnostics must not change /v1/me */
      }
    };
    const replyFail = (
      stage: OwnerMeStage,
      code: string,
      message: string,
      extra?: { field_errors?: { field: string; message: string }[]; retryAfter?: number; sqlstate?: string },
    ) => {
      const result = fail(request.id, code, message, { field_errors: extra?.field_errors });
      if (extra?.retryAfter !== undefined) {
        void reply.header("Retry-After", String(extra.retryAfter));
      }
      emit(result.status, stage, extra?.sqlstate);
      return reply.status(result.status).send(result.body);
    };

    emit(0, "request_received");
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      return replyFail("jwt_rejected", API_ERROR_CODES.AUTHENTICATION_REQUIRED, SIGN_IN_REQUIRED);
    }
    if (!deps.verifyJwt || !deps.pool) {
      return replyFail("response_sent", "UNAVAILABLE", "Service unavailable.");
    }
    let access: VerifiedAccess;
    try {
      access = await deps.verifyJwt(token);
    } catch {
      return replyFail("jwt_rejected", API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
    }
    const parsed = parseOwnerEmail(access.email);
    if (!parsed.ok) {
      return replyFail("jwt_rejected", API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
    }
    emit(0, "jwt_verified");
    const limited = limiter.allow(access.sub);
    if (!limited.ok) {
      return replyFail("response_sent", API_ERROR_CODES.RATE_LIMITED, "Too many requests. Try again later.", {
        retryAfter: limited.retryAfterSec,
      });
    }
    try {
      const row = await withApiRole(deps.pool, async (client) => {
        const result = await client.query<ProvisionRow>(
          `select actor_id, workspace_id, account_status, display_email, setup_completed, first_sign_in, analytics_alias_id, workspace_version
           from identity.provision_owner($1::uuid, $2, $3)`,
          [access.sub, parsed.display, parsed.normalized],
        );
        return result.rows[0];
      });
      if (!isUsableProvisionRow(row)) {
        return replyFail("bootstrap_query_failed", "UNAVAILABLE", "Service unavailable.");
      }
      if (row.account_status === "deleted") {
        return replyFail("response_sent", API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
      }
      let canPublish = false;
      let entitlementSource = "unverified";
      if (row.account_status === "deleting") {
        canPublish = false;
        entitlementSource = "unverified";
      } else if (row.setup_completed) {
        const allowance = await withTenant(deps.pool, row.workspace_id, row.actor_id, async (client) => {
          const consumed = await client.query<{
            free_jobs_consumed: number;
            trial_started_at: Date | string | null;
            trial_ends_at: Date | string | null;
            trial_jobs_consumed: number;
          }>(
            `select free_jobs_consumed, trial_started_at, trial_ends_at, trial_jobs_consumed
             from commercial.job_allowances where workspace_id = $1`,
            [row.workspace_id],
          );
          return consumed.rows[0];
        });
        const freeConsumed = Number(allowance?.free_jobs_consumed ?? 0);
        const trialConsumed = Number(allowance?.trial_jobs_consumed ?? 0);
        const trialEnds = allowance?.trial_ends_at
          ? allowance.trial_ends_at instanceof Date
            ? allowance.trial_ends_at.getTime()
            : Date.parse(String(allowance.trial_ends_at))
          : Number.NaN;
        const trialActive =
          Boolean(allowance?.trial_started_at) && Number.isFinite(trialEnds) && Date.now() < trialEnds && trialConsumed < 20;
        entitlementSource = trialActive ? "trial" : "free";
        canPublish = freeConsumed < 3 || trialActive;
      }
      const body = success(request.id, {
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
          source: entitlementSource,
          can_publish: canPublish,
        },
        first_sign_in: row.first_sign_in,
        analytics_alias_id: row.analytics_alias_id,
        support_url: publicSupportUrl("SUPPORT_URL" in deps.env ? deps.env.SUPPORT_URL : undefined),
      });
      emit(200, "response_sent");
      return body;
    } catch (error) {
      return replyFail(ownerMeDatabaseStage(error), "UNAVAILABLE", "Service unavailable.", {
        sqlstate: ownerMeSqlstate(error),
      });
    }
  });

  app.post("/v1/analytics/batch", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_REQUIRED, SIGN_IN_REQUIRED);
    }
    if (!deps.verifyJwt || !deps.pool) {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
    const key = idempotencyKey(request);
    if (!key || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
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
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Invalid request.");
    }
    const record = body as Record<string, unknown>;
    if (Object.keys(record).some((field) => field !== "events")) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Unknown fields are not allowed.");
    }
    const events = record.events;
    if (!Array.isArray(events) || events.length === 0 || events.length > 50) {
      return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "events must contain 1–50 items.", {
        field_errors: [{ field: "events", message: "1–50 events required" }],
      });
    }
    const hash = JSON.stringify(body);
    const prior = idempotency.get(`${access.sub}:${key}`);
    if (prior) {
      if (prior.hash !== hash) {
        return sendFail(request, reply, API_ERROR_CODES.IDEMPOTENCY_MISMATCH, "Idempotency key was reused with a different body.");
      }
      return reply.status(prior.status).send(prior.body);
    }
    try {
      const owner = await withApiRole(deps.pool, async (client) => {
        const result = await client.query<ProvisionRow>(
          `select actor_id, workspace_id, account_status, display_email, setup_completed, first_sign_in, analytics_alias_id
           from identity.provision_owner($1::uuid, $2, $3)`,
          [access.sub, parsedEmail.display, parsedEmail.normalized],
        );
        return result.rows[0];
      });
      if (!owner) {
        return sendFail(request, reply, API_ERROR_CODES.AUTHENTICATION_FAILED, GENERIC_AUTH);
      }
      if (owner.account_status === "suspended") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_SUSPENDED, "This account cannot make changes.");
      }
      if (owner.account_status !== "active") {
        return sendFail(request, reply, API_ERROR_CODES.ACCOUNT_DELETING, "This account is not available.");
      }
      const now = Date.now();
      const rows: unknown[][] = [];
      for (const item of events) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Invalid event.");
        }
        const event = item as Record<string, unknown>;
        const allowed = new Set(["event_id", "event_name", "occurred_at", "schema_version", "job_id", "properties"]);
        if (Object.keys(event).some((field) => !allowed.has(field))) {
          return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Unknown fields are not allowed.");
        }
        if (typeof event.event_name !== "string" || !isClientAnalyticsEvent(event.event_name)) {
          return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Event is not allowed.");
        }
        if (typeof event.event_id !== "string") {
          return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "event_id is required.", {
            field_errors: [{ field: "event_id", message: "UUID required" }],
          });
        }
        if (event.schema_version !== ANALYTICS_SCHEMA_VERSION) {
          return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Unsupported schema_version.");
        }
        if (typeof event.occurred_at !== "string") {
          return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "occurred_at is required.");
        }
        const occurred = Date.parse(event.occurred_at);
        if (Number.isNaN(occurred) || now - occurred > 7 * 24 * 60 * 60 * 1000) {
          return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Event expired.");
        }
        const properties =
          event.properties === undefined
            ? {}
            : event.properties && typeof event.properties === "object" && !Array.isArray(event.properties)
              ? (event.properties as Record<string, unknown>)
              : null;
        if (!properties || !analyticsPropertiesAreSafe(properties)) {
          return sendFail(request, reply, API_ERROR_CODES.VALIDATION_FAILED, "Event properties are not allowed.");
        }
        rows.push([
          owner.workspace_id,
          event.event_id,
          event.event_name,
          ANALYTICS_SCHEMA_VERSION,
          event.occurred_at,
          owner.analytics_alias_id,
          event.job_id ?? null,
          JSON.stringify(properties),
        ]);
      }
      await withTenant(deps.pool, owner.workspace_id, owner.actor_id, async (client) => {
        for (const row of rows) {
          await client.query(
            `insert into commercial.analytics_events (
              workspace_id, event_id, event_name, schema_version, occurred_at,
              pseudonymous_owner_id, job_id, safe_properties_json
            ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
            on conflict (event_id) do nothing`,
            row,
          );
        }
      });
      const bodyOut = success(request.id, { accepted: rows.length });
      idempotency.set(`${access.sub}:${key}`, { hash, status: 202, body: bodyOut });
      return reply.status(202).send(bodyOut);
    } catch {
      return sendFail(request, reply, "UNAVAILABLE", "Service unavailable.");
    }
  });

  registerWorkspaceRoutes(app, deps, {
    limiterAllow: (key) => limiter.allow(key),
  });
  registerJobRoutes(app, deps, {
    limiterAllow: (key) => limiter.allow(key),
  });
  registerItemRoutes(app, deps, {
    limiterAllow: (key) => limiter.allow(key),
  });
  registerCustomerRoutes(app, deps, {
    limiterAllow: (key) => limiter.allow(key),
  });
  registerDraftRoutes(app, deps, {
    limiterAllow: (key) => limiter.allow(key),
  });
  registerChangeRoutes(app, deps, {
    limiterAllow: (key) => limiter.allow(key),
  });
  registerQuotePublishRoutes(app, deps, {
    limiterAllow: (key) => limiter.allow(key),
  });
  registerInvoiceRoutes(app, deps, {
    limiterAllow: (key) => limiter.allow(key),
  });
  registerSubscriptionRoutes(app, deps, {
    limiterAllow: (key) => limiter.allow(key),
  });
  registerExportRoutes(app, deps, {
    limiterAllow: (key) => limiter.allow(key),
  });
  registerDeletionRoutes(app, deps, {
    limiterAllow: (key) => limiter.allow(key),
  });
  registerSupportRoutes(app, deps, {
    limiterAllow: (key) => limiter.allow(key),
  });
  registerActionGrantRoutes(app, deps, {
    limiterAllow: (key) => limiter.allow(key),
  });
  registerRequestMutationRoutes(app, deps, {
    limiterAllow: (key) => limiter.allow(key),
  });
  registerEmailWebhookRoutes(app, deps);
  registerPortalRoutes(app, deps);

  return app;
}
