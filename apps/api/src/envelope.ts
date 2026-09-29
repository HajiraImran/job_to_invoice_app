import { API_ERROR_CODES, httpStatusForCode, type ApiErrorBody } from "@job-to-invoice/schemas";
import { redactText } from "@job-to-invoice/schemas";
import { currentRequestTiming } from "./request-context.ts";

const DATABASE_FAILURE_REPLY = {
  timeout: { code: API_ERROR_CODES.DATABASE_TIMEOUT, message: "The database took too long to respond. Try again." },
  unavailable: { code: API_ERROR_CODES.DATABASE_UNAVAILABLE, message: "The database is unavailable right now. Try again." },
} as const;

export function requestId(): string {
  return crypto.randomUUID();
}

export function serverTime(): string {
  return new Date().toISOString();
}

export function success<T>(id: string, data: T) {
  return {
    data,
    meta: { request_id: id, server_time: serverTime() },
  };
}

export function fail(
  id: string,
  code: string,
  message: string,
  options?: {
    field_errors?: ApiErrorBody["error"]["field_errors"];
    retryable?: boolean;
    duplicates?: ApiErrorBody["error"]["duplicates"];
  },
): { status: number; body: ApiErrorBody } {
  const databaseFailure = code === "UNAVAILABLE" ? currentRequestTiming()?.dbFailure : undefined;
  if (databaseFailure) {
    code = DATABASE_FAILURE_REPLY[databaseFailure].code;
    message = DATABASE_FAILURE_REPLY[databaseFailure].message;
  }
  const status = code === "UNAVAILABLE" ? 503 : httpStatusForCode(code);
  return {
    status,
    body: {
      error: {
        code,
        message: redactText(message),
        field_errors: options?.field_errors ?? [],
        retryable: options?.retryable ?? (status === 429 || status >= 500),
        ...(options?.duplicates ? { duplicates: options.duplicates } : {}),
      },
      meta: { request_id: id, server_time: serverTime() },
    },
  };
}

export { API_ERROR_CODES };
