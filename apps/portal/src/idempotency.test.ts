import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdempotencyKey, PortalIdentifierError, postPortalDecision } from "./idempotency";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const NATIVE_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const SENSITIVE = {
  csrf: "csrf-token-value",
  token: "approval-fragment-token",
  email: "customer@example.com",
  signer_name: "Riley Chen",
  snapshot_sha256: "ab".repeat(32),
};

function payload() {
  return {
    decision: "approve" as const,
    signer_name: SENSITIVE.signer_name,
    consent_version: "apr04.v1",
    consent_accepted: true,
    snapshot_sha256: SENSITIVE.snapshot_sha256,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createIdempotencyKey", () => {
  it("uses native randomUUID when available", () => {
    const randomUUID = vi.fn(() => NATIVE_UUID);
    const getRandomValues = vi.fn(() => {
      throw new Error("fallback must not run");
    });
    vi.stubGlobal("crypto", { randomUUID, getRandomValues });

    expect(createIdempotencyKey()).toBe(NATIVE_UUID);
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it("falls back to getRandomValues with UUID v4 version and variant bits", () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => (index === 6 ? 0xff : index === 8 ? 0x3f : index));
    vi.stubGlobal("crypto", {
      getRandomValues: (target: Uint8Array) => {
        target.set(bytes);
        return target;
      },
    });

    const value = createIdempotencyKey();
    expect(value).toMatch(UUID_V4);
    expect(value).toBe("00010203-0405-4f07-bf09-0a0b0c0d0e0f");
    expect(value.slice(14, 15)).toBe("4");
    expect(["8", "9", "a", "b"]).toContain(value.slice(19, 20));
  });

  it("falls back when randomUUID throws, as on some non-secure HTTP origins", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => {
        throw new Error("insecure origin");
      },
      getRandomValues: (target: Uint8Array) => {
        target.fill(0);
        return target;
      },
    });

    const value = createIdempotencyKey();
    expect(value).toBe("00000000-0000-4000-8000-000000000000");
    expect(value).toMatch(UUID_V4);
  });

  it("throws a generic error when Web Crypto is unavailable", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => createIdempotencyKey()).toThrow(PortalIdentifierError);
    try {
      createIdempotencyKey();
    } catch (error) {
      expect(error).toBeInstanceOf(PortalIdentifierError);
      expect((error as Error).message).toBe("unavailable");
      expect((error as Error).message).not.toMatch(/crypto|uuid|stack|http/i);
    }
  });
});

describe("postPortalDecision", () => {
  it("sends the generated idempotency key and does not fetch when randomness is unavailable", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("crypto", { randomUUID: () => NATIVE_UUID });

    await postPortalDecision({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      csrf: SENSITIVE.csrf,
      payload: payload(),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe(NATIVE_UUID);
    expect(headers["x-csrf-token"]).toBe(SENSITIVE.csrf);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/portal/decision");

    fetchImpl.mockClear();
    vi.stubGlobal("crypto", undefined);
    await expect(
      postPortalDecision({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        csrf: SENSITIVE.csrf,
        payload: payload(),
      }),
    ).rejects.toBeInstanceOf(PortalIdentifierError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not log token, CSRF, email, signer name, or document hash", async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      lines.push(args.map((value) => String(value)).join(" "));
    };
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "info").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    vi.stubGlobal("crypto", { randomUUID: () => NATIVE_UUID });

    await postPortalDecision({
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      csrf: SENSITIVE.csrf,
      payload: payload(),
    });

    const joined = lines.join("\n");
    expect(joined).not.toContain(SENSITIVE.csrf);
    expect(joined).not.toContain(SENSITIVE.token);
    expect(joined).not.toContain(SENSITIVE.email);
    expect(joined).not.toContain(SENSITIVE.signer_name);
    expect(joined).not.toContain(SENSITIVE.snapshot_sha256);
  });
});
