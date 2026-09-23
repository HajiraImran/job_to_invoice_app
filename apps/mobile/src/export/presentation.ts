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
