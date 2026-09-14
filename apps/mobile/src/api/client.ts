export type OwnerBootstrap = {
  user: { id: string; status: string; display_email: string };
  workspace: { id: string; setup_completed: boolean };
  entitlement: { source: string; can_publish: boolean };
  first_sign_in: boolean;
  analytics_alias_id: string;
};

export type ApiError = {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
};

export async function ownerRequest<T>(options: {
  apiBaseUrl: string;
  path: string;
  accessToken: string;
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
}): Promise<{ ok: true; data: T } | { ok: false; error: ApiError }> {
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${options.accessToken}`,
  };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.idempotencyKey) {
    headers["idempotency-key"] = options.idempotencyKey;
  }
  try {
    const response = await fetch(`${options.apiBaseUrl}${options.path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const json = (await response.json()) as {
      data?: T;
      error?: { code?: string; message?: string; retryable?: boolean };
    };
    if (!response.ok) {
      return {
        ok: false,
        error: {
          status: response.status,
          code: json.error?.code ?? "UNAVAILABLE",
          message: json.error?.message ?? "Request failed.",
          retryable: json.error?.retryable === true,
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
