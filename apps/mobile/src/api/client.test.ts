import { afterEach, describe, expect, it, vi } from "vitest";
import { ownerRequest } from "./client.ts";

describe("ownerRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps an API UNAVAILABLE payload distinct from a fetch failure", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("http://192.168.1.10:3001/v1/drafts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/publish");
      return {
        ok: false,
        status: 503,
        json: async () => ({
          error: { code: "UNAVAILABLE", message: "Service unavailable.", retryable: true },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await ownerRequest({
      apiBaseUrl: "http://192.168.1.10:3001",
      path: "/v1/drafts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/publish",
      method: "POST",
      accessToken: "test-access-token",
      body: { preview_hash: "ab".repeat(32), recipient_email: "customer@example.com" },
      idempotencyKey: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ifMatch: 4,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        status: 503,
        code: "UNAVAILABLE",
        message: "Service unavailable.",
        retryable: true,
        field_errors: undefined,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("collapses a thrown fetch into UNAVAILABLE without the API service message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Network request failed");
      }),
    );
    const result = await ownerRequest({
      apiBaseUrl: "http://192.168.1.10:3001",
      path: "/v1/drafts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/publish",
      method: "POST",
      accessToken: "test-access-token",
    });
    expect(result).toEqual({
      ok: false,
      error: {
        status: 0,
        code: "UNAVAILABLE",
        message: "Could not reach the network. Try again.",
        retryable: true,
      },
    });
  });
});
