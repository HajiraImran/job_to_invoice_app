export const API_ERROR_CODES = {
  AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",
  AUTHENTICATION_FAILED: "AUTHENTICATION_FAILED",
  ACCOUNT_SUSPENDED: "ACCOUNT_SUSPENDED",
  ACCOUNT_DELETING: "ACCOUNT_DELETING",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  IDEMPOTENCY_MISMATCH: "IDEMPOTENCY_MISMATCH",
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

export type ApiFieldError = { field: string; message: string };

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode | string;
    message: string;
    field_errors: ApiFieldError[];
    retryable: boolean;
  };
  meta: { request_id: string; server_time?: string };
};

export type ApiSuccessBody<T> = {
  data: T;
  meta: { request_id: string; server_time: string };
};

export function httpStatusForCode(code: string): number {
  switch (code) {
    case API_ERROR_CODES.AUTHENTICATION_REQUIRED:
    case API_ERROR_CODES.AUTHENTICATION_FAILED:
      return 401;
    case API_ERROR_CODES.ACCOUNT_SUSPENDED:
    case API_ERROR_CODES.ACCOUNT_DELETING:
      return 403;
    case API_ERROR_CODES.VALIDATION_FAILED:
      return 422;
    case API_ERROR_CODES.IDEMPOTENCY_MISMATCH:
      return 409;
    case API_ERROR_CODES.RATE_LIMITED:
      return 429;
    default:
      return 500;
  }
}
