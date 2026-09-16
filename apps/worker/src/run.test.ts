import { describe, expect, it } from "vitest";
import { loadEnv, loadWorkerEnv } from "@job-to-invoice/config";
import { createWorkerTick, workerPollReady, workerStatus } from "./run.ts";

describe("worker original PDF", () => {
  it("identifies the original-pdf worker without claiming work on import", () => {
    expect(workerStatus(loadEnv({ APP_ENV: "development" }))).toMatch(/original-pdf/);
  });

  it("fails closed when the worker cannot poll", () => {
    expect(workerPollReady(loadWorkerEnv({ APP_ENV: "development" }))).toBe("missing_database");
    expect(
      workerPollReady(
        loadWorkerEnv({
          APP_ENV: "development",
          DATABASE_URL_WORKER: "postgres://worker:stored@127.0.0.1:5432/app",
        }),
      ),
    ).toBe("missing_storage");
    expect(
      workerPollReady(
        loadWorkerEnv({
          APP_ENV: "development",
          DATABASE_URL_WORKER: "postgres://worker:stored@127.0.0.1:5432/app",
          STORAGE_ENDPOINT: "http://127.0.0.1:9000",
          STORAGE_REGION: "us-east-1",
          STORAGE_FORCE_PATH_STYLE: "true",
          STORAGE_WORKER_ACCESS_KEY_ID: "wk_access_dev01",
          STORAGE_WORKER_SECRET_ACCESS_KEY: "wk_secret_dev01_value",
        }),
      ),
    ).toBe("ready");
  });

  it("rate-limits no_work and does not overlap ticks", async () => {
    const stages: string[] = [];
    let inflight = 0;
    let maxInflight = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let calls = 0;
    const tick = createWorkerTick({
      run: async () => {
        calls += 1;
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        began();
        await gate;
        inflight -= 1;
        return "idle";
      },
      onStage: (stage) => stages.push(stage),
      now: () => 1_000,
      noWorkEveryMs: 30_000,
    });
    const first = tick();
    await started;
    const overlapping = tick();
    expect(calls).toBe(1);
    release();
    await Promise.all([first, overlapping]);
    expect(maxInflight).toBe(1);
    expect(stages).toEqual(["no_work"]);
    await tick();
    expect(stages).toEqual(["no_work"]);
    const later = createWorkerTick({
      run: async () => "idle",
      onStage: (stage) => stages.push(stage),
      now: (() => {
        let t = 0;
        return () => {
          t += 30_000;
          return t;
        };
      })(),
      noWorkEveryMs: 30_000,
    });
    await later();
    await later();
    expect(stages.filter((stage) => stage === "no_work")).toHaveLength(3);
  });

  it("does not log credentials or endpoints from worker status", () => {
    const env = loadWorkerEnv({
      APP_ENV: "development",
      DATABASE_URL_WORKER: "postgres://worker:stored@127.0.0.1:5432/app",
      STORAGE_ENDPOINT: "http://127.0.0.1:9000",
      STORAGE_WORKER_ACCESS_KEY_ID: "wk_access_dev01",
      STORAGE_WORKER_SECRET_ACCESS_KEY: "wk_secret_dev01_value",
      STORAGE_REGION: "us-east-1",
      STORAGE_FORCE_PATH_STYLE: "true",
    });
    const status = workerStatus(env);
    expect(status).not.toContain("wk_secret_dev01_value");
    expect(status).not.toContain("postgres://");
    expect(status).not.toContain("127.0.0.1");
  });
});
