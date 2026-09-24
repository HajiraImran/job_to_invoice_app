export type OwnerBootstrap = {
  user: { id: string; status: string; display_email: string };
  workspace: { id: string; version: number; setup_completed: boolean };
  entitlement: { source: string; can_publish: boolean };
  first_sign_in: boolean;
  analytics_alias_id: string;
  support_url?: string | null;
};

export type ApiError = {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  field_errors?: { field: string; message: string }[];
  duplicates?: { id: string; name: string; archived: boolean }[];
};

export async function ownerRequest<T>(options: {
  apiBaseUrl: string;
  path: string;
  accessToken: string;
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: string | number;
  headers?: Record<string, string>;
}): Promise<{ ok: true; data: T } | { ok: false; error: ApiError }> {
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${options.accessToken}`,
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
  try {
    const response = await fetch(`${options.apiBaseUrl}${options.path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const json = (await response.json()) as {
      data?: T;
      error?: {
        code?: string;
        message?: string;
        retryable?: boolean;
        field_errors?: { field: string; message: string }[];
        duplicates?: { id: string; name: string; archived: boolean }[];
      };
    };
    if (!response.ok) {
      return {
        ok: false,
        error: {
          status: response.status,
          code: json.error?.code ?? "UNAVAILABLE",
          message: json.error?.message ?? "Request failed.",
          retryable: json.error?.retryable === true,
          field_errors: json.error?.field_errors,
          duplicates: json.error?.duplicates,
        },
      };
    }
    return { ok: true, data: json.data as T };
  } catch {
    return {
      ok: false,
      error: { status: 0, code: "UNAVAILABLE", message: "Could not reach the network. Try again.", retryable: true },
    };
  }
}

export type OwnerRequestOptions = Omit<Parameters<typeof ownerRequest>[0], "apiBaseUrl" | "accessToken">;
