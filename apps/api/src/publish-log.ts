import { ApiTransactionError } from "./db.ts";
import { allowlistedSqlstate } from "./me-log.ts";

export const QUOTE_PUBLISH_EVENT = "quote_publish";

export const QUOTE_PUBLISH_STAGES = [
  "request_received",
  "jwt_verified",
  "jwt_rejected",
  "validation_failed",
  "configuration_unavailable",
  "database_connect_failed",
  "transaction_start_failed",
  "set_role_failed",
  "tenant_context_failed",
  "publish_query_failed",
  "response_sent",
] as const;

export type QuotePublishStage = (typeof QUOTE_PUBLISH_STAGES)[number];

export const QUOTE_PUBLISH_SAFE_KEYS = ["event", "status", "stage"] as const;
export const QUOTE_PUBLISH_OPTIONAL_KEYS = ["sqlstate"] as const;

export type QuotePublishSafeEvent = {
  event: typeof QUOTE_PUBLISH_EVENT;
  status: number;
  stage: QuotePublishStage;
  sqlstate?: string;
};

const STAGE_SET = new Set<string>(QUOTE_PUBLISH_STAGES);
const ALLOWED_KEYS = new Set<string>([...QUOTE_PUBLISH_SAFE_KEYS, ...QUOTE_PUBLISH_OPTIONAL_KEYS]);
const SQLSTATE_CLASS = /^(08|0A|22|23|25|28|40|42|53|54|55|57|58|P0|XX)$/;

export function sqlstateCategory(value: unknown): string | undefined {
  if (typeof value === "string" && SQLSTATE_CLASS.test(value)) {
    return value;
  }
  const code = allowlistedSqlstate(value);
  return code ? code.slice(0, 2) : undefined;
}

export function quotePublishDatabaseStage(error: unknown): QuotePublishStage {
  if (error instanceof ApiTransactionError) {
    if (error.stage === "session_query_failed") {
      return "publish_query_failed";
    }
    if (
      error.stage === "database_connect_failed" ||
      error.stage === "transaction_start_failed" ||
      error.stage === "set_role_failed" ||
      error.stage === "tenant_context_failed"
    ) {
      return error.stage;
    }
  }
  return "publish_query_failed";
}

export function quotePublishSqlstate(error: unknown): string | undefined {
  if (error instanceof ApiTransactionError) {
    return sqlstateCategory(error.sqlstate);
  }
  if (error && typeof error === "object" && "code" in error) {
    return sqlstateCategory((error as { code?: unknown }).code);
  }
  return undefined;
}

export function quotePublishSafeEvent(input: {
  status: number;
  stage: QuotePublishStage;
  sqlstate?: string;
}): QuotePublishSafeEvent {
  const event: QuotePublishSafeEvent = {
    event: QUOTE_PUBLISH_EVENT,
    status: input.status,
    stage: input.stage,
  };
  const sqlstate = sqlstateCategory(input.sqlstate);
  if (sqlstate) {
    event.sqlstate = sqlstate;
  }
  return event;
}

export function quotePublishEventHasOnlySafeFields(value: unknown): value is QuotePublishSafeEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !ALLOWED_KEYS.has(key))) {
    return false;
  }
  if (!QUOTE_PUBLISH_SAFE_KEYS.every((key) => keys.includes(key))) {
    return false;
  }
  if (record.sqlstate !== undefined && sqlstateCategory(record.sqlstate) !== record.sqlstate) {
    return false;
  }
  return (
    record.event === QUOTE_PUBLISH_EVENT &&
    typeof record.status === "number" &&
    Number.isFinite(record.status) &&
    typeof record.stage === "string" &&
    STAGE_SET.has(record.stage)
  );
}

export function writeQuotePublishEvent(
  event: QuotePublishSafeEvent,
  write: (line: string) => void = console.log,
): void {
  write(JSON.stringify(quotePublishSafeEvent(event)));
}
