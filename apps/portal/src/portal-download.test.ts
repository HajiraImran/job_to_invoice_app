import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePortalDownloadResponse, runPortalPdfDownload } from "./portal-download";
import { portalCopy } from "./review";

const root = dirname(fileURLToPath(import.meta.url));
const READY_URL = "https://files.example.test/quote.pdf";
const SENSITIVE_URL =
  "https://files.example.test/quote.pdf?sig=test-signature&token=test-token&X-Amz-Signature=test-amz";

function envelope(data: unknown, extra?: Record<string, unknown>) {
  return {
    data,
    meta: { request_id: "req-1", server_time: "2026-01-01T00:00:00.000Z" },
    ...extra,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function captureConsole(): string[] {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "info").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.spyOn(console, "debug").mockImplementation(capture);
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parsePortalDownloadResponse", () => {
  it("accepts a ready response with a safe absolute http(s) URL", () => {
    const parsed = parsePortalDownloadResponse({
      status: 200,
      json: envelope({ document_id: "doc-1", state: "ready", url: READY_URL }),
    });
    expect(parsed).toEqual({ ok: true, url: READY_URL });
  });

  it("rejects a missing URL", () => {
    expect(
      parsePortalDownloadResponse({
        status: 200,
        json: envelope({ document_id: "doc-1", state: "ready" }),
      }),
    ).toEqual({ ok: false, reason: "missing_url" });
    expect(
      parsePortalDownloadResponse({
        status: 200,
        json: envelope({ document_id: "doc-1", state: "ready", url: null }),
      }),
    ).toEqual({ ok: false, reason: "missing_url" });
  });

  it("rejects an empty URL", () => {
    expect(
      parsePortalDownloadResponse({
        status: 200,
        json: envelope({ document_id: "doc-1", state: "ready", url: "" }),
      }),
    ).toEqual({ ok: false, reason: "empty_url" });
    expect(
      parsePortalDownloadResponse({
        status: 200,
        json: envelope({ document_id: "doc-1", state: "ready", url: "   " }),
      }),
    ).toEqual({ ok: false, reason: "empty_url" });
  });

  it("rejects a relative URL", () => {
    expect(
      parsePortalDownloadResponse({
        status: 200,
        json: envelope({ document_id: "doc-1", state: "ready", url: "/relative/quote.pdf" }),
      }),
    ).toEqual({ ok: false, reason: "malformed_url" });
    expect(
      parsePortalDownloadResponse({
        status: 200,
        json: envelope({ document_id: "doc-1", state: "ready", url: "quote.pdf" }),
      }),
    ).toEqual({ ok: false, reason: "malformed_url" });
  });

  it("rejects a malformed URL", () => {
    expect(
      parsePortalDownloadResponse({
        status: 200,
        json: envelope({ document_id: "doc-1", state: "ready", url: "not a url" }),
      }),
    ).toEqual({ ok: false, reason: "malformed_url" });
  });

  it("rejects an unsafe javascript: URL", () => {
    expect(
      parsePortalDownloadResponse({
        status: 200,
        json: envelope({ document_id: "doc-1", state: "ready", url: "javascript:alert(1)" }),
      }),
    ).toEqual({ ok: false, reason: "unsafe_url" });
  });

  it("rejects an unsafe data: URL", () => {
    expect(
      parsePortalDownloadResponse({
        status: 200,
        json: envelope({ document_id: "doc-1", state: "ready", url: "data:application/pdf;base64,QQ==" }),
      }),
    ).toEqual({ ok: false, reason: "unsafe_url" });
  });

  it("rejects an unsafe file: URL", () => {
    expect(
      parsePortalDownloadResponse({
        status: 200,
        json: envelope({ document_id: "doc-1", state: "ready", url: "file:///tmp/quote.pdf" }),
      }),
    ).toEqual({ ok: false, reason: "unsafe_url" });
  });

  it("rejects an unsafe blob: URL", () => {
    expect(
      parsePortalDownloadResponse({
        status: 200,
        json: envelope({ document_id: "doc-1", state: "ready", url: "blob:https://files.example.test/quote" }),
      }),
    ).toEqual({ ok: false, reason: "unsafe_url" });
  });

  it("rejects a non-2xx response even if a URL is present", () => {
    expect(
      parsePortalDownloadResponse({
        status: 500,
        json: envelope(
          { document_id: "doc-1", state: "ready", url: READY_URL },
          { error: { message: "Service unavailable.", stack: "Error: secret-stack" } },
        ),
      }),
    ).toEqual({ ok: false, reason: "http" });
  });

  it("rejects invalid JSON payloads", () => {
    expect(parsePortalDownloadResponse({ status: 200, json: "ready" })).toEqual({ ok: false, reason: "json" });
    expect(parsePortalDownloadResponse({ status: 200, json: null })).toEqual({ ok: false, reason: "json" });
    expect(parsePortalDownloadResponse({ status: 200, json: [] })).toEqual({ ok: false, reason: "json" });
    expect(parsePortalDownloadResponse({ status: 200, json: { meta: {} } })).toEqual({ ok: false, reason: "json" });
  });

  it("rejects a document that is not ready", () => {
    expect(
      parsePortalDownloadResponse({
        status: 200,
        json: envelope({ document_id: "doc-1", state: "preparing", url: READY_URL }),
      }),
    ).toEqual({ ok: false, reason: "not_ready" });
    expect(
      parsePortalDownloadResponse({
        status: 200,
        json: envelope({ document_id: "doc-1", state: "failed", url: null }),
      }),
    ).toEqual({ ok: false, reason: "not_ready" });
  });
});

describe("runPortalPdfDownload", () => {
  it("navigates in the same context to the validated PDF URL", async () => {
    const assign = vi.fn();
    const busy: boolean[] = [];
    const fetchImpl = vi.fn(async () => jsonResponse(envelope({ document_id: "doc-1", state: "ready", url: READY_URL })));

    const outcome = await runPortalPdfDownload({
      inFlight: { current: false },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      assign,
      onBusy: (value) => busy.push(value),
    });

    expect(outcome).toBe("navigated");
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(READY_URL);
    expect(busy).toEqual([true, false]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/portal/download",
      expect.objectContaining({ method: "GET", cache: "no-store", credentials: "same-origin" }),
    );
  });

  it("ignores duplicate clicks while the request is active", async () => {
    const assign = vi.fn();
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const inFlight = { current: false };
    const busy: boolean[] = [];

    const first = runPortalPdfDownload({
      inFlight,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      assign,
      onBusy: (value) => busy.push(value),
    });
    const second = runPortalPdfDownload({
      inFlight,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      assign,
      onBusy: (value) => busy.push(value),
    });

    expect(await second).toBe("ignored");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(inFlight.current).toBe(true);
    expect(busy[0]).toBe(true);

    resolveFetch?.(jsonResponse(envelope({ document_id: "doc-1", state: "ready", url: READY_URL })));
    expect(await first).toBe("navigated");
    expect(assign).toHaveBeenCalledTimes(1);
    expect(inFlight.current).toBe(false);
    expect(busy).toEqual([true, false]);
  });

  it("keeps a safe error outcome for non-2xx, invalid JSON, not-ready, and unsafe URLs", async () => {
    const cases: Array<{ name: string; response: Response }> = [
      { name: "http", response: jsonResponse({ error: { message: "Service unavailable.", stack: "secret-stack" } }, 503) },
      { name: "json", response: new Response("not-json", { status: 200 }) },
      { name: "not_ready", response: jsonResponse(envelope({ document_id: "doc-1", state: "preparing", url: null })) },
      {
        name: "unsafe",
        response: jsonResponse(envelope({ document_id: "doc-1", state: "ready", url: "javascript:alert(1)" })),
      },
    ];

    for (const testCase of cases) {
      const assign = vi.fn();
      const outcome = await runPortalPdfDownload({
        inFlight: { current: false },
        fetchImpl: (async () => testCase.response) as unknown as typeof fetch,
        assign,
      });
      expect(outcome, testCase.name).toBe("error");
      expect(assign, testCase.name).not.toHaveBeenCalled();
    }
  });

  it("retries with a new request after a failure", async () => {
    const assign = vi.fn();
    const fetchImpl = vi.fn();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({ error: { message: "Service unavailable." } }, 503))
      .mockResolvedValueOnce(jsonResponse(envelope({ document_id: "doc-1", state: "ready", url: READY_URL })));
    const inFlight = { current: false };

    expect(
      await runPortalPdfDownload({
        inFlight,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        assign,
      }),
    ).toBe("error");
    expect(assign).not.toHaveBeenCalled();
    expect(
      await runPortalPdfDownload({
        inFlight,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        assign,
      }),
    ).toBe("navigated");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(READY_URL);
  });

  it("does not log or expose signed URL query parameters", async () => {
    const lines = captureConsole();
    const assign = vi.fn();
    const outcome = await runPortalPdfDownload({
      inFlight: { current: false },
      fetchImpl: (async () => jsonResponse(envelope({ document_id: "doc-1", state: "ready", url: SENSITIVE_URL }))) as unknown as typeof fetch,
      assign,
    });

    expect(outcome).toBe("navigated");
    expect(assign).toHaveBeenCalledWith(SENSITIVE_URL);
    const joined = lines.join("\n");
    expect(joined).not.toContain(SENSITIVE_URL);
    expect(joined).not.toContain("test-signature");
    expect(joined).not.toContain("test-token");
    expect(joined).not.toContain("test-amz");
    expect(joined).not.toContain("X-Amz-Signature");
  });

  it("does not expose provider payloads on failure", async () => {
    const lines = captureConsole();
    const assign = vi.fn();
    const outcome = await runPortalPdfDownload({
      inFlight: { current: false },
      fetchImpl: (async () =>
        jsonResponse(
          { error: { code: "UNAVAILABLE", message: "minio://documents/object", stack: "Error: secret-stack" } },
          500,
        )) as unknown as typeof fetch,
      assign,
    });

    expect(outcome).toBe("error");
    expect(assign).not.toHaveBeenCalled();
    const joined = lines.join("\n");
    expect(joined).not.toContain("minio://");
    expect(joined).not.toContain("secret-stack");
    expect(joined).not.toContain("UNAVAILABLE");
  });
});

describe("customer portal PDF download UI", () => {
  it("uses one accessible action on review and receipt, with no JSON-endpoint anchors", () => {
    const receipt = readFileSync(join(root, "../app/review/receipt/page.tsx"), "utf8");
    const document = readFileSync(join(root, "../app/review/document/page.tsx"), "utf8");
    const action = readFileSync(join(root, "./portal-download-action.tsx"), "utf8");
    const helper = readFileSync(join(root, "./portal-download.ts"), "utf8");

    expect(receipt).toContain("payment_claimed");
    expect(receipt).toContain("portalCopy.accepted");
    expect(receipt).toContain("portalCopy.rejected");
    expect(receipt).toContain("<PortalPdfDownloadAction />");
    expect(document).toContain("<PortalPdfDownloadAction />");
    expect(document).toContain("createIdempotencyKey()");
    expect(document).toContain("portalCopy.approve");
    expect(document).toContain("portalCopy.decline");
    expect(document).toContain('type="checkbox"');
    expect(action).toContain("runPortalPdfDownload");
    expect(action).toContain("portalCopy.downloadPdf");
    expect(action).toContain("portalCopy.pdfLoading");
    expect(action).toContain("portalCopy.downloadError");
    expect(action).toContain("portalCopy.retry");
    expect(action).toContain('type="button"');
    expect(action).toContain("disabled={busy}");
    expect(action).toContain("aria-busy={busy}");
    expect(action).toContain('role="status"');
    expect(action).toContain('role="alert"');
    expect(action).toContain("window.location.assign(validatedUrl)");
    expect(helper).toContain('method: "GET"');
    expect(helper).toContain('cache: "no-store"');
    expect(helper).toContain('credentials: "same-origin"');
    expect(helper).not.toContain("x-csrf-token");
    expect(action).not.toContain("x-csrf-token");
    expect(receipt).not.toContain("window.open");
    expect(document).not.toContain("window.open");
    expect(action).not.toContain("window.open");
    expect(helper).not.toContain("window.open");
    const access = readFileSync(join(root, "../app/review/page.tsx"), "utf8");
    const home = readFileSync(join(root, "../app/page.tsx"), "utf8");
    expect(access).not.toContain('href="/api/portal/download"');
    expect(home).not.toContain('href="/api/portal/download"');
    expect(access).not.toContain("/api/portal/document/download");
    expect(home).not.toContain("/api/portal/document/download");
    expect(receipt).not.toContain("/api/portal/document/download");
    expect(document).not.toContain("/api/portal/document/download");
    expect(receipt).not.toContain("localStorage");
    expect(document).not.toContain("localStorage");
    expect(action).not.toContain("localStorage");
    expect(action).not.toContain("sessionStorage");
    expect(action).not.toContain("console.");
    expect(helper).not.toContain("console.");
    expect(receipt).not.toContain(SENSITIVE_URL);
    expect(document).not.toContain(SENSITIVE_URL);
    expect(action).not.toContain(SENSITIVE_URL);
    expect(helper).not.toContain(SENSITIVE_URL);
    expect(receipt).not.toContain("X-Amz-Signature");
    expect(document).not.toContain("X-Amz-Signature");
    expect(action).not.toContain("X-Amz-Signature");
    expect(portalCopy.downloadError).toBe("The PDF could not be opened. Try again.");
    expect(portalCopy.downloadError).not.toMatch(/minio|stack|signature|token|object key/i);
    expect(portalCopy.retry).toBe("Try again");
  });

  it("keeps quote review and receipt visible when the download action reports an error", () => {
    const receipt = readFileSync(join(root, "../app/review/receipt/page.tsx"), "utf8");
    const document = readFileSync(join(root, "../app/review/document/page.tsx"), "utf8");
    const action = readFileSync(join(root, "./portal-download-action.tsx"), "utf8");
    expect(receipt).toContain("receipt.number");
    expect(receipt).toContain("receipt.revision_label");
    expect(receipt).toContain("receipt.decided_at");
    expect(document).toContain("doc.business_name");
    expect(document).toContain("doc.number");
    expect(document).toContain("setKind(\"confirm_accept\")");
    expect(document).toContain("setKind(\"confirm_reject\")");
    expect(action).toContain('if (outcome === "error")');
    expect(action).toContain("setError(true)");
    expect(action).not.toContain("setKind");
    expect(action).not.toContain("setReceipt");
    expect(action).not.toContain("setDoc");
  });
});
