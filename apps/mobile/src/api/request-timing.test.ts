import { describe, expect, it, vi } from "vitest";
import { ownerRequest, requestRoute, type OwnerRequestEvent } from "./client.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("ownerRequest timing and timeouts", () => {
  it("aborts a hung request at the timeout and reports it as a timeout, not a generic network failure", async () => {
    const events: OwnerRequestEvent[] = [];
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })));
        }),
    ) as unknown as typeof fetch;
    const result = await ownerRequest({
      apiBaseUrl: "http://api.test",
      path: "/v1/jobs?state=active",
      accessToken: "secret-access-token",
      fetchImpl,
      timeoutMs: 5,
      logRequest: (event) => events.push(event),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ status: 0, code: "UNAVAILABLE", retryable: true, network: "timeout" });
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "owner_request", method: "GET", route: "/v1/jobs", status: 0, network: "timeout" });
  });

  it("sends a correlation id and logs the server request id without tokens, query values, or ids", async () => {
    const events: OwnerRequestEvent[] = [];
    let sentHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      sentHeaders = init?.headers as Record<string, string>;
      return {
        ok: false,
        status: 503,
        json: async () => ({
          error: { code: "DATABASE_TIMEOUT", message: "The database took too long to respond. Try again.", retryable: true },
          meta: { request_id: "22222222-2222-4222-8222-222222222222" },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const result = await ownerRequest({
      apiBaseUrl: "http://api.test",
      path: `/v1/jobs/${jobId}?search=Acme%20Plumbing`,
      accessToken: "secret-access-token",
      fetchImpl,
      logRequest: (event) => events.push(event),
    });
    expect(sentHeaders["x-client-request-id"]).toMatch(UUID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DATABASE_TIMEOUT");
      expect(result.error.requestId).toBe("22222222-2222-4222-8222-222222222222");
    }
    expect(events[0]).toMatchObject({
      route: "/v1/jobs/:id",
      status: 503,
      code: "DATABASE_TIMEOUT",
      client_request_id: sentHeaders["x-client-request-id"],
      request_id: "22222222-2222-4222-8222-222222222222",
    });
    const logged = JSON.stringify(events);
    expect(logged).not.toContain("secret-access-token");
    expect(logged).not.toContain("Acme");
    expect(logged).not.toContain(jobId);
  });

  it("normalizes routes for diagnostics", () => {
    expect(requestRoute("/v1/jobs")).toBe("/v1/jobs");
    expect(requestRoute("/v1/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/quote?x=1")).toBe("/v1/jobs/:id/quote");
  });
});
