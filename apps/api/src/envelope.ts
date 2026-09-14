import { API_ERROR_CODES, httpStatusForCode, type ApiErrorBody } from "@job-to-invoice/schemas";
import { redactText } from "@job-to-invoice/schemas";

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
  options?: { field_errors?: ApiErrorBody["error"]["field_errors"]; retryable?: boolean },
): { status: number; body: ApiErrorBody } {
  const status = code === "UNAVAILABLE" ? 503 : httpStatusForCode(code);
  return {
    status,
    body: {
      error: {
        code,
        message: redactText(message),
        field_errors: options?.field_errors ?? [],
        retryable: options?.retryable ?? (status === 429 || status >= 500),
      },
      meta: { request_id: id, server_time: serverTime() },
    },
  };
}

export { API_ERROR_CODES };
