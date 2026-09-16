import { describe, expect, it } from "vitest";
import {
  WORKER_PDF_EVENT,
  WORKER_PDF_SAFE_KEYS,
  workerPdfEventHasOnlySafeFields,
  workerPdfSafeEvent,
  writeWorkerPdfEvent,
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

describe("worker PDF console events", () => {
  it("emits only allowlisted fields", () => {
    const event = workerPdfSafeEvent({ stage: "claimed" });
    expect(workerPdfEventHasOnlySafeFields(event)).toBe(true);
    expect(Object.keys(event).sort()).toEqual([...WORKER_PDF_SAFE_KEYS].sort());
    expect(event.event).toBe(WORKER_PDF_EVENT);
    expect(event.stage).toBe("claimed");
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
});
