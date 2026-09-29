import { describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { loadEnv } from "@job-to-invoice/config";
import type { ApiRequestEvent } from "./request-context.ts";

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

  it("reports per-request timing without request content", async () => {
    const requests: ApiRequestEvent[] = [];
    const app = buildApp({
      env: loadEnv({ APP_ENV: "development" }),
      logRequest: (event) => {
        requests.push(event);
      },
    });
    const clientId = "4f0c1f7e-58c1-4d3b-9a55-0c7d9b0f4a11";
    const response = await app.inject({
      method: "GET",
      url: "/v1/health?secret=value",
      headers: { "x-client-request-id": clientId, authorization: "Bearer token-value" },
    });
    expect(response.headers["server-timing"]).toMatch(/^total;dur=\d+, db-wait;dur=\d+, db;dur=\d+, app;dur=\d+$/);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      event: "api_request",
      client_request_id: clientId,
      method: "GET",
      route: "/v1/health",
      status: 200,
      db_transactions: 0,
    });
    expect(requests[0]?.request_id).toBe(response.json().meta.request_id);
    expect(JSON.stringify(requests)).not.toMatch(/secret|token-value/);

    await app.inject({ method: "GET", url: "/v1/health", headers: { "x-client-request-id": "not-a-uuid" } });
    expect(requests[1]?.client_request_id).toBeUndefined();
    await app.close();
  });
});
