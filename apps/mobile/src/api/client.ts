export type OwnerBootstrap = {
  user: { id: string; status: string; display_email: string };
  workspace: { id: string; version: number; setup_completed: boolean };
  entitlement: { source: string; can_publish: boolean };
  first_sign_in: boolean;
  analytics_alias_id: string;
  support_url?: string | null;
};

/**
 * Why a status-0 request failed. `code` stays `UNAVAILABLE` for every status-0 failure because
 * idempotency-key retention depends on it; this field carries the finer distinction.
 */
export type NetworkFailureKind = "timeout" | "unreachable" | "offline";

export type ApiError = {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  field_errors?: { field: string; message: string }[];
  duplicates?: { id: string; name: string; archived: boolean }[];
  network?: NetworkFailureKind;
  requestId?: string;
};

export const OWNER_REQUEST_TIMEOUT_MS = 20_000;

export type OwnerRequestEvent = {
  event: "owner_request";
  method: string;
  route: string;
  status: number;
  code?: string;
  network?: NetworkFailureKind;
  ms: number;
  client_request_id: string;
  request_id?: string;
};

const UUID_SEGMENT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Path shape without identifiers or query values, safe for diagnostics. */
export function requestRoute(path: string): string {
  const queryAt = path.indexOf("?");
  return (queryAt === -1 ? path : path.slice(0, queryAt)).replace(UUID_SEGMENT, ":id");
}

export function createClientRequestId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  // Correlation only; never used as a secret or idempotency key.
  const hex = Array.from({ length: 32 }, (_, index) => {
    const nibble = Math.floor(Math.random() * 16);
    if (index === 12) {
      return "4";
    }
    return (index === 16 ? (nibble & 0x3) | 0x8 : nibble).toString(16);
  });
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function defaultLogRequest(event: OwnerRequestEvent): void {
  const dev = (globalThis as { __DEV__?: boolean }).__DEV__ === true;
  if (dev) {
    console.info(JSON.stringify(event));
  }
}

export type OwnerRequestInput = {
  apiBaseUrl: string;
  path: string;
  accessToken: string;
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: string | number;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logRequest?: (event: OwnerRequestEvent) => void;
};

export async function ownerRequest<T>(
  options: OwnerRequestInput,
): Promise<{ ok: true; data: T } | { ok: false; error: ApiError }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const logRequest = options.logRequest ?? defaultLogRequest;
  const method = options.method ?? "GET";
  const clientRequestId = createClientRequestId();
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${options.accessToken}`,
    "x-client-request-id": clientRequestId,
    ...(options.headers ?? {}),
  };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.idempotencyKey) {
    headers["idempotency-key"] = options.idempotencyKey;
  }
  if (options.ifMatch !== undefined) {
    headers["if-match"] = String(options.ifMatch);
  }
  const startedAt = now();
  const report = (status: number, error?: ApiError) => {
    logRequest({
      event: "owner_request",
      method,
      route: requestRoute(options.path),
      status,
      ...(error ? { code: error.code } : {}),
      ...(error?.network ? { network: error.network } : {}),
      ms: Math.max(0, now() - startedAt),
      client_request_id: clientRequestId,
      ...(error?.requestId ? { request_id: error.requestId } : {}),
    });
  };
  const controller = typeof AbortController === "function" ? new AbortController() : undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller?.abort();
  }, options.timeoutMs ?? OWNER_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${options.apiBaseUrl}${options.path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller?.signal,
    });
    const json = (await response.json()) as {
      data?: T;
      meta?: { request_id?: string };
      error?: {
        code?: string;
        message?: string;
        retryable?: boolean;
        field_errors?: { field: string; message: string }[];
        duplicates?: { id: string; name: string; archived: boolean }[];
      };
    };
    if (!response.ok) {
      const error: ApiError = {
        status: response.status,
        code: json.error?.code ?? "UNAVAILABLE",
        message: json.error?.message ?? "Request failed.",
        retryable: json.error?.retryable === true,
        field_errors: json.error?.field_errors,
        duplicates: json.error?.duplicates,
        requestId: typeof json.meta?.request_id === "string" ? json.meta.request_id : undefined,
      };
      report(response.status, error);
      return { ok: false, error };
    }
    report(response.status);
    return { ok: true, data: json.data as T };
  } catch {
    const error: ApiError = {
      status: 0,
      code: "UNAVAILABLE",
      message: "Could not reach the network. Try again.",
      retryable: true,
      network: timedOut ? "timeout" : "unreachable",
    };
    report(0, error);
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

export type OwnerRequestOptions = Omit<OwnerRequestInput, "apiBaseUrl" | "accessToken">;
