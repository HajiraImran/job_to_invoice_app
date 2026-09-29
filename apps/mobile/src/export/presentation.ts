export type ExportRecord = {
  id: string;
  status: "queued" | "running" | "ready" | "failed" | "expired" | string;
  cutoff_at: string | null;
  created_at: string | null;
  download_until: string | null;
  delete_after: string | null;
  ready_at: string | null;
  schema_version: number;
  part_count: number;
  job_count: number | null;
  bytes: number | null;
  sha256: string | null;
  download_available: boolean;
  reused?: boolean;
  manifest: unknown;
  error_code: string | null;
};

export type ExportViewKind =
  | "loading"
  | "offline"
  | "access_expired"
  | "error"
  | "idle"
  | "step_up"
  | "working"
  | "ready"
  | "failed";

export function exportPath(): string {
  return "/(tabs)/settings/data";
}

export function presentExport(input: {
  authStatus: string;
  loading: boolean;
  requesting: boolean;
  stepUp: boolean;
  record?: ExportRecord | null;
  error?: string;
}): { kind: ExportViewKind; exportDisabled: boolean; message?: string } {
  if (input.authStatus === "access_expired") {
    return { kind: "access_expired", exportDisabled: true };
  }
  if (input.authStatus === "offline_cached") {
    return { kind: "offline", exportDisabled: true, message: input.error };
  }
  if (input.stepUp) {
    return { kind: "step_up", exportDisabled: true, message: input.error };
  }
  if (input.requesting) {
    return { kind: "working", exportDisabled: true };
  }
  if (input.loading && !input.record) {
    return { kind: "loading", exportDisabled: true };
  }
  if (input.error && !input.record) {
    return { kind: "error", exportDisabled: false, message: input.error };
  }
  if (input.record?.status === "failed") {
    return { kind: "failed", exportDisabled: false, message: input.error };
  }
  if (input.record && (input.record.status === "queued" || input.record.status === "running")) {
    return { kind: "working", exportDisabled: true };
  }
  if (input.record?.status === "ready") {
    return { kind: "ready", exportDisabled: false, message: input.error };
  }
  return { kind: "idle", exportDisabled: false, message: input.error };
}

export type PrivacySurface =
  | "loading"
  | "overview"
  | "preparing"
  | "ready"
  | "confirm_deletion"
  | "locked"
  | "offline"
  | "access_expired";

export function presentPrivacySurface(input: {
  authStatus: string;
  loading: boolean;
  hasExport: boolean;
  exportStatus?: string;
  requesting: boolean;
  deletionLocked: boolean;
  confirmingDeletion: boolean;
}): PrivacySurface {
  if (input.authStatus === "access_expired") {
    return "access_expired";
  }
  if (input.authStatus === "offline_cached") {
    return "offline";
  }
  if (input.deletionLocked) {
    return "locked";
  }
  if (input.confirmingDeletion) {
    return "confirm_deletion";
  }
  if (input.requesting || input.exportStatus === "queued" || input.exportStatus === "running") {
    return "preparing";
  }
  if (input.exportStatus === "ready") {
    return "ready";
  }
  if (input.loading && !input.hasExport) {
    return "loading";
  }
  return "overview";
}

export function exportPollShouldStop(status: string): boolean {
  return status === "ready" || status === "failed" || status === "expired";
}

export function nextExportRecord<T>(current: T | null, loaded: { ok: true; record: T | null } | { ok: false }): T | null {
  if (!loaded.ok) {
    return current;
  }
  return loaded.record;
}

export function exportIdempotencyAfterFailure(current: string, code: string | undefined): string | undefined {
  return code === "IDEMPOTENCY_MISMATCH" ? undefined : current;
}

export function privacyCommandBlocked(input: { offline: boolean; expired: boolean; busy: boolean; locked: boolean }): boolean {
  return input.offline || input.expired || input.busy || input.locked;
}

export function downloadLogIsSafe(logged: string, url: string): boolean {
  return url.length === 0 || !logged.includes(url);
}

export function exportCompletedPropertiesAreSafe(props: Record<string, unknown>): boolean {
  return Object.keys(props).sort().join(",") === "job_count_bucket,size_bucket";
}

export function privacyLogIsSafe(text: string, secrets: readonly string[]): boolean {
  return secrets.every((secret) => secret.length === 0 || !text.includes(secret));
}

export const APPLE_SUBSCRIPTIONS_URL = "https://apps.apple.com/account/subscriptions";

export function exportStatusLabel(status: string): string {
  switch (status) {
    case "queued":
    case "running":
      return "Preparing your export";
    case "ready":
      return "Export ready";
    case "failed":
      return "Export failed";
    case "expired":
      return "Export expired";
    default:
      return "No export yet";
  }
}
