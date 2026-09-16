import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  RESEND_WEBHOOK_MAX_BODY_BYTES,
  verifyResendWebhook,
} from "@job-to-invoice/config";
import { API_ERROR_CODES } from "@job-to-invoice/schemas";
import type { Pool } from "pg";
import { withApiRole } from "./db.ts";
import { fail } from "./envelope.ts";

function webhookSecretFromEnv(env: Record<string, unknown>): string | undefined {
  const value = env.EMAIL_WEBHOOK_SECRET;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function headerValue(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) {
    return undefined;
  }
  const value = raw?.trim();
  return value ? value : undefined;
}

function eventType(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.type === "string") {
    return payload.type;
  }
  if (typeof payload.event_type === "string") {
    return payload.event_type;
  }
  return undefined;
}

function providerMessageId(payload: Record<string, unknown>): string | undefined {
  const data = payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  if (typeof record.email_id === "string" && record.email_id.length > 0) {
    return record.email_id;
  }
  if (typeof record.id === "string" && record.id.length > 0) {
    return record.id;
  }
  return undefined;
}

function sendWebhookFail(request: FastifyRequest, reply: FastifyReply) {
  const result = fail(request.id, API_ERROR_CODES.AUTHENTICATION_FAILED, "Invalid webhook.");
  return reply.status(result.status).send(result.body);
}

export function registerEmailWebhookRoutes(
  app: FastifyInstance,
  deps: { env: Record<string, unknown>; pool?: Pool; nowSec?: () => number },
): void {
  app.post(
    "/webhooks/email",
    {
      bodyLimit: RESEND_WEBHOOK_MAX_BODY_BYTES,
      config: { rawBody: true },
    },
    async (request, reply) => {
      const secret = webhookSecretFromEnv(deps.env);
      if (!secret || !deps.pool) {
        return sendWebhookFail(request, reply);
      }
      const rawBody = request.rawBody;
      if (!rawBody || !Buffer.isBuffer(rawBody)) {
        return sendWebhookFail(request, reply);
      }
      if (rawBody.byteLength > RESEND_WEBHOOK_MAX_BODY_BYTES) {
        return sendWebhookFail(request, reply);
      }
      const svixId = headerValue(request.headers["svix-id"]);
      const svixTimestamp = headerValue(request.headers["svix-timestamp"]);
      const svixSignature = headerValue(request.headers["svix-signature"]);
      if (!svixId || !svixTimestamp || !svixSignature) {
        return sendWebhookFail(request, reply);
      }
      const verified = verifyResendWebhook({
        secret,
        svixId,
        svixTimestamp,
        svixSignature,
        rawBody,
        nowSec: deps.nowSec ? deps.nowSec() : undefined,
      });
      if (!verified.ok) {
        return sendWebhookFail(request, reply);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return sendWebhookFail(request, reply);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return sendWebhookFail(request, reply);
      }
      const payload = parsed as Record<string, unknown>;
      const type = eventType(payload);
      if (!type) {
        return sendWebhookFail(request, reply);
      }
      try {
        await withApiRole(deps.pool, async (client) => {
          await client.query(
            `select applied, duplicate from commercial.apply_resend_email_event($1, $2, $3)`,
            [svixId, type, providerMessageId(payload) ?? null],
          );
        });
      } catch {
        return sendWebhookFail(request, reply);
      }
      return reply.status(200).send({ received: true });
    },
  );
}
