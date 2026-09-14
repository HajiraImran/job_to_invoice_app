import { describe, expect, it } from "vitest";
import { workerStatus } from "./run.ts";
import { loadEnv } from "@job-to-invoice/config";

describe("worker foundation", () => {
  it("does not claim outbox work", () => {
    expect(workerStatus(loadEnv({ APP_ENV: "development" }))).toMatch(/not implemented/);
  });
});
