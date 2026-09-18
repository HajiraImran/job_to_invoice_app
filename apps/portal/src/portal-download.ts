export type PortalDownloadFailureReason =
  | "http"
  | "json"
  | "not_ready"
  | "missing_url"
  | "empty_url"
  | "malformed_url"
  | "unsafe_url";

export type PortalDownloadParseResult =
  | { ok: true; url: string }
  | { ok: false; reason: PortalDownloadFailureReason };

export type PortalPdfDownloadOutcome = "ignored" | "navigated" | "error";

const SAFE_DOWNLOAD_PROTOCOLS = new Set(["http:", "https:"]);

function classifyDownloadUrl(value: unknown): { ok: true; url: string } | { ok: false; reason: Exclude<PortalDownloadFailureReason, "http" | "json" | "not_ready"> } {
  if (value === undefined || value === null) {
    return { ok: false, reason: "missing_url" };
  }
  if (typeof value !== "string") {
    return { ok: false, reason: "malformed_url" };
  }
  if (value.length === 0 || value.trim().length === 0) {
    return { ok: false, reason: "empty_url" };
  }
  try {
    const parsed = new URL(value);
    if (!SAFE_DOWNLOAD_PROTOCOLS.has(parsed.protocol)) {
      return { ok: false, reason: "unsafe_url" };
    }
    if (!parsed.hostname) {
      return { ok: false, reason: "malformed_url" };
    }
    return { ok: true, url: value };
  } catch {
    return { ok: false, reason: "malformed_url" };
  }
}

export function parsePortalDownloadResponse(input: { status: number; json: unknown }): PortalDownloadParseResult {
  if (!Number.isInteger(input.status) || input.status < 200 || input.status >= 300) {
    return { ok: false, reason: "http" };
  }
  if (input.json === null || typeof input.json !== "object" || Array.isArray(input.json)) {
    return { ok: false, reason: "json" };
  }
  const data = (input.json as { data?: unknown }).data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "json" };
  }
  const record = data as { state?: unknown; url?: unknown };
  if (record.state !== "ready") {
    return { ok: false, reason: "not_ready" };
  }
  return classifyDownloadUrl(record.url);
}

export async function runPortalPdfDownload(input: {
  inFlight: { current: boolean };
  fetchImpl?: typeof fetch;
  assign: (url: string) => void;
  onBusy?: (busy: boolean) => void;
}): Promise<PortalPdfDownloadOutcome> {
  if (input.inFlight.current) {
    return "ignored";
  }
  input.inFlight.current = true;
  input.onBusy?.(true);
  try {
    const fetchImpl = input.fetchImpl ?? fetch;
    const response = await fetchImpl("/api/portal/download", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    });
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return "error";
    }
    const parsed = parsePortalDownloadResponse({ status: response.status, json });
    if (!parsed.ok) {
      return "error";
    }
    input.assign(parsed.url);
    return "navigated";
  } catch {
    return "error";
  } finally {
    input.inFlight.current = false;
    input.onBusy?.(false);
  }
}
