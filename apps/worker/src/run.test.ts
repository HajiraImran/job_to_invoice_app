import { describe, expect, it } from "vitest";
import { workerStatus } from "./run.ts";
import { loadEnv } from "@job-to-invoice/config";

describe("worker original PDF", () => {
  it("identifies the original-pdf worker without claiming work on import", () => {
    expect(workerStatus(loadEnv({ APP_ENV: "development" }))).toMatch(/original-pdf/);
  });
});
