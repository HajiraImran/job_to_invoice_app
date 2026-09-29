import { describe, expect, it } from "vitest";
import {
  networkCodeOf,
  pdfFailureErrorCode,
  WORKER_PDF_EVENT,
  WORKER_PDF_SAFE_KEYS,
  workerPdfEventHasOnlySafeFields,
  workerPdfFailureEvent,
  workerPdfSafeEvent,
  writeWorkerPdfEvent,
  writeWorkerPdfFailure,
} from "./worker-log.ts";

const FORBIDDEN = [
  "stack",
  "cause",
  "authorization",
  "access_token",
  "database_url",
  "password",
  "email",
  "user_id",
  "workspace_id",
  "document_id",
  "object_key",
  "payload",
  "url",
];

describe("worker storage failure diagnostics", () => {
  it("reports a fixed network code from nested SDK errors without the message", () => {
    const socket = Object.assign(new Error("connect ETIMEDOUT 192.168.1.38:9000"), { code: "ETIMEDOUT" });
    const sdk = Object.assign(new Error("socket hang up key=AKIA123 X-Amz-Signature=abc"), {
      name: "Error",
      cause: new AggregateError([socket], "all failed"),
    });
    expect(networkCodeOf(sdk)).toBe("ETIMEDOUT");
    const event = workerPdfFailureEvent({ stage: "storage_put", error: sdk, attempt: 2 });
    expect(event).toEqual({
      event: WORKER_PDF_EVENT,
      stage: "storage_put",
      category: "storage_unavailable",
      attempt: 2,
      networkCode: "ETIMEDOUT",
    });
    expect(workerPdfEventHasOnlySafeFields(event)).toBe(true);
    expect(JSON.stringify(event)).not.toMatch(/192\.168|AKIA|Signature|hang up/);
    expect(networkCodeOf(Object.assign(new Error("x"), { code: "EWHATEVER host=secret" }))).toBeUndefined();
  });

  it("records storage failures with an actionable task error code", () => {
    const denied = Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    expect(pdfFailureErrorCode("storage_put", denied)).toBe("STORAGE_REJECTED");
    expect(pdfFailureErrorCode("storage_put", Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(
      "STORAGE_UNAVAILABLE",
    );
    expect(pdfFailureErrorCode("rendering", new Error("chromium crashed"))).toBe("PDF_RENDER_FAILED");
    expect(workerPdfEventHasOnlySafeFields({ event: WORKER_PDF_EVENT, stage: "storage_put", networkCode: "leak" })).toBe(
      false,
    );
  });
});

describe("worker PDF console events", () => {
  it("emits only allowlisted fields", () => {
    const event = workerPdfSafeEvent({ stage: "claimed" });
    expect(workerPdfEventHasOnlySafeFields(event)).toBe(true);
    expect(Object.keys(event).sort()).toEqual([...WORKER_PDF_SAFE_KEYS].sort());
    expect(event.event).toBe(WORKER_PDF_EVENT);
    expect(event.stage).toBe("claimed");
  });

  it("keeps an allowlisted SQLSTATE and drops anything else", () => {
    const kept = workerPdfSafeEvent({ stage: "set_role_failed", sqlstate: "42501" });
    expect(kept.sqlstate).toBe("42501");
    expect(workerPdfEventHasOnlySafeFields(kept)).toBe(true);
    const dropped = workerPdfSafeEvent({ stage: "database_connect_failed", sqlstate: "ECONNREFUSED" });
    expect(dropped.sqlstate).toBeUndefined();
    expect(Object.keys(dropped)).not.toContain("sqlstate");
  });

  it("strips extra fields and never serializes secrets, keys, or errors", () => {
    const lines: string[] = [];
    writeWorkerPdfEvent(
      {
        stage: "retry_scheduled",
        message: "could not PutObject",
        stack: "Error: boom\n    at Object.<anonymous>",
        error: new Error("could not PutObject"),
        object_key: "workspaces/11111111-1111-4111-8111-111111111111/documents/x.pdf",
        document_id: "22222222-2222-4222-8222-222222222222",
        DATABASE_URL_WORKER: "postgres://worker:stored@db:5432/app",
      } as never,
      (line) => lines.push(line),
    );
    expect(lines).toHaveLength(1);
    const parsed: unknown = JSON.parse(lines[0] ?? "{}");
    expect(workerPdfEventHasOnlySafeFields(parsed)).toBe(true);
    const serialized = lines[0] ?? "";
    expect(serialized).not.toMatch(/Error:|at Object|PutObject|postgres:\/\//i);
    for (const key of FORBIDDEN) {
      expect(serialized.toLowerCase()).not.toContain(`"${key}"`);
    }
  });

  it("redacts PDF failure diagnostics to stage, category, status, and SQLSTATE", () => {
    const lines: string[] = [];
    const error = Object.assign(new Error("PutObject failed for customer@example.com"), {
      stack: "Error: boom\n    at putObject",
      code: "23505",
      $metadata: { httpStatusCode: 403, requestId: "req-secret" },
      Bucket: "job-to-invoice-documents-development",
      Key: "workspaces/11111111-1111-4111-8111-111111111111/documents/quote.pdf",
      response: "<Error><Message>secret body</Message></Error>",
    });
    writeWorkerPdfFailure({ stage: "storage_put", error, attempt: 3 }, (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    const parsed: unknown = JSON.parse(lines[0] ?? "{}");
    expect(workerPdfEventHasOnlySafeFields(parsed)).toBe(true);
    expect(parsed).toEqual({
      event: WORKER_PDF_EVENT,
      stage: "storage_put",
      sqlstate: "23505",
      category: "storage_rejected",
      httpStatus: 403,
      attempt: 3,
    });
    const serialized = lines[0] ?? "";
    expect(serialized).not.toMatch(/customer@|example\.com|secret|quote\.pdf|workspaces\/|job-to-invoice|boom|putObject/i);
    const databaseOnly = workerPdfFailureEvent({
      stage: "complete_pdf",
      error: Object.assign(new Error("postgres://worker:stored@db.internal:5432/app"), { code: "42501" }),
      attempt: 4,
    });
    expect(databaseOnly).toEqual({
      event: WORKER_PDF_EVENT,
      stage: "complete_pdf",
      sqlstate: "42501",
      category: "database",
      attempt: 4,
    });
    expect(JSON.stringify(databaseOnly)).not.toMatch(/postgres:\/\/|stored@|db\.internal/);
  });
});
