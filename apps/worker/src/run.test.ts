import { describe, expect, it } from "vitest";
import { loadEnv, loadWorkerEnv } from "@job-to-invoice/config";
import { WorkerTransactionError } from "./db.ts";
import { createWorkerTick, startWorkerPolling, workerPollReady, workerStatus } from "./run.ts";

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

  it("runs the first claim immediately after started", async () => {
    const stages: string[] = [];
    let claims = 0;
    const { stop } = await startWorkerPolling({
      run: async () => {
        claims += 1;
        return "idle";
      },
      onStage: (stage) => stages.push(stage),
      pollMs: 60_000,
    });
    stop();
    expect(claims).toBe(1);
    expect(stages[0]).toBe("started");
    expect(stages).toContain("no_work");
    expect(stages.indexOf("no_work")).toBeGreaterThan(0);
  });

  it("emits no_work after a successful empty claim and does not convert failures to no_work", async () => {
    const stages: string[] = [];
    const tick = createWorkerTick({
      run: async () => "idle",
      onStage: (stage) => stages.push(stage),
      now: () => 1_000,
    });
    await tick();
    expect(stages).toEqual(["no_work"]);

    const failed: string[] = [];
    const failing = createWorkerTick({
      run: async () => {
        throw new WorkerTransactionError("set_role_failed", "42501");
      },
      onStage: (stage) => failed.push(stage),
      now: () => 1_000,
    });
    await failing();
    expect(failed).toEqual(["set_role_failed"]);
    expect(failed).not.toContain("no_work");
  });

  it("emits each database stage failure", async () => {
    const cases = [
      "database_connect_failed",
      "transaction_start_failed",
      "set_role_failed",
      "claim_query_failed",
      "claim_timed_out",
    ] as const;
    for (const stage of cases) {
      const seen: string[] = [];
      const sqlstates: Array<string | undefined> = [];
      const tick = createWorkerTick({
        run: async () => {
          throw new WorkerTransactionError(stage, stage === "set_role_failed" ? "42501" : undefined);
        },
        onStage: (value, sqlstate) => {
          seen.push(value);
          sqlstates.push(sqlstate);
        },
      });
      await tick();
      expect(seen).toEqual([stage]);
      expect(seen).not.toContain("no_work");
      if (stage === "set_role_failed") {
        expect(sqlstates).toEqual(["42501"]);
      }
    }
  });

  it("recovers on a later tick after a claim timeout", async () => {
    const stages: string[] = [];
    let hang = true;
    let attempts = 0;
    const tick = createWorkerTick({
      run: async () => {
        attempts += 1;
        if (hang) {
          throw new WorkerTransactionError("claim_timed_out");
        }
        return "idle";
      },
      onStage: (stage) => stages.push(stage),
      now: () => 1_000,
    });
    await tick();
    expect(attempts).toBe(1);
    expect(stages).toEqual(["claim_timed_out"]);
    hang = false;
    await tick();
    expect(attempts).toBe(2);
    expect(stages).toEqual(["claim_timed_out", "no_work"]);
  });

  it("releases busy after database_connect_failed so the next tick can run", async () => {
    const stages: string[] = [];
    let fail = true;
    const tick = createWorkerTick({
      run: async () => {
        if (fail) {
          throw new WorkerTransactionError("database_connect_failed", "08006");
        }
        return "idle";
      },
      onStage: (stage) => stages.push(stage),
      now: () => 1_000,
    });
    await tick();
    fail = false;
    await tick();
    expect(stages).toEqual(["database_connect_failed", "no_work"]);
  });

  it("does not emit claim_timed_out or overlap when rendering exceeds 8 seconds", async () => {
    const stages: string[] = [];
    let inflight = 0;
    let maxInflight = 0;
    let completions = 0;
    const tick = createWorkerTick({
      run: async () => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((resolve) => setTimeout(resolve, 8_500));
        completions += 1;
        inflight -= 1;
        return "done";
      },
      onStage: (stage) => stages.push(stage),
    });
    const first = tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const overlapping = tick();
    await Promise.all([first, overlapping]);
    expect(maxInflight).toBe(1);
    expect(completions).toBe(1);
    expect(stages).not.toContain("claim_timed_out");
  });

  it("does not emit claim_timed_out or overlap when uploading exceeds 8 seconds", async () => {
    const stages: string[] = [];
    let inflight = 0;
    let maxInflight = 0;
    let uploads = 0;
    const tick = createWorkerTick({
      run: async () => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        await new Promise((resolve) => setTimeout(resolve, 8_500));
        uploads += 1;
        inflight -= 1;
        return "done";
      },
      onStage: (stage) => stages.push(stage),
    });
    const first = tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const overlapping = tick();
    await Promise.all([first, overlapping]);
    expect(maxInflight).toBe(1);
    expect(uploads).toBe(1);
    expect(stages).not.toContain("claim_timed_out");
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
