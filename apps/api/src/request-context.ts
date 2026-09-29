import { AsyncLocalStorage } from "node:async_hooks";

export type DatabaseFailureKind = "timeout" | "unavailable";

export type RequestTiming = {
  startedAt: number;
  dbWaitMs: number;
  dbMs: number;
  dbTransactions: number;
  dbFailure?: DatabaseFailureKind;
};

const storage = new AsyncLocalStorage<RequestTiming>();

export function createRequestTiming(now: () => number = Date.now): RequestTiming {
  return { startedAt: now(), dbWaitMs: 0, dbMs: 0, dbTransactions: 0 };
}

export function runWithRequestTiming<T>(timing: RequestTiming, fn: () => T): T {
  return storage.run(timing, fn);
}

export function currentRequestTiming(): RequestTiming | undefined {
  return storage.getStore();
}

export function recordDatabaseFailure(kind: DatabaseFailureKind): void {
  const timing = storage.getStore();
  if (!timing) {
    return;
  }
  if (timing.dbFailure !== "timeout") {
    timing.dbFailure = kind;
  }
}

export type ApiRequestEvent = {
  event: "api_request";
  request_id: string;
  client_request_id?: string;
  method: string;
  route: string;
  status: number;
  total_ms: number;
  db_wait_ms: number;
  db_ms: number;
  db_transactions: number;
  db_failure?: DatabaseFailureKind;
};

const CLIENT_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function clientRequestId(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  return value && CLIENT_REQUEST_ID.test(value) ? value.toLowerCase() : undefined;
}

export function apiRequestEvent(input: {
  requestId: string;
  clientRequestId?: string;
  method: string;
  route: string;
  status: number;
  timing: RequestTiming;
  now?: () => number;
}): ApiRequestEvent {
  const now = input.now ?? Date.now;
  return {
    event: "api_request",
    request_id: input.requestId,
    ...(input.clientRequestId ? { client_request_id: input.clientRequestId } : {}),
    method: input.method,
    route: input.route,
    status: input.status,
    total_ms: Math.max(0, now() - input.timing.startedAt),
    db_wait_ms: Math.round(input.timing.dbWaitMs),
    db_ms: Math.round(input.timing.dbMs),
    db_transactions: input.timing.dbTransactions,
    ...(input.timing.dbFailure ? { db_failure: input.timing.dbFailure } : {}),
  };
}

export function writeApiRequestEvent(event: ApiRequestEvent): void {
  try {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  } catch {
    /* diagnostics must not throw */
  }
}

export function serverTimingHeader(timing: RequestTiming, now: () => number = Date.now): string {
  const total = Math.max(0, now() - timing.startedAt);
  return [
    `total;dur=${total}`,
    `db-wait;dur=${Math.round(timing.dbWaitMs)}`,
    `db;dur=${Math.round(timing.dbMs)}`,
    `app;dur=${Math.max(0, Math.round(total - timing.dbWaitMs - timing.dbMs))}`,
  ].join(", ");
}
