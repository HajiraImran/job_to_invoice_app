import { describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { loadEnv } from "@job-to-invoice/config";

describe("foundation API", () => {
  it("serves /v1/health", async () => {
    const events: unknown[] = [];
    const app = buildApp({
      env: loadEnv({ APP_ENV: "development" }),
      logOwnerMe: (event) => {
        events.push(event);
      },
    });
    const response = await app.inject({ method: "GET", url: "/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("ok");
    expect(events).toEqual([]);
    await app.close();
  });
});
