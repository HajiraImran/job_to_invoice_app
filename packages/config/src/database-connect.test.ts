import { describe, expect, it } from "vitest";
import {
  DATABASE_CONNECT_ATTEMPT_TIMEOUT_DEFAULT_MS,
  DATABASE_CONNECT_ATTEMPT_TIMEOUT_MAX_MS,
  DATABASE_CONNECT_DEADLINE_DEFAULT_MS,
  DATABASE_CONNECT_DEADLINE_MAX_MS,
  resolveDatabaseConnectTimeouts,
} from "./database-connect.ts";

const SECRET = "postgres://api:super-secret@db.internal:5432/app";

describe("resolveDatabaseConnectTimeouts", () => {
  it("uses fail-fast defaults when values are missing or empty", () => {
    expect(resolveDatabaseConnectTimeouts({})).toEqual({
      databaseConnectAttemptTimeoutMs: DATABASE_CONNECT_ATTEMPT_TIMEOUT_DEFAULT_MS,
      databaseConnectDeadlineMs: DATABASE_CONNECT_DEADLINE_DEFAULT_MS,
    });
    expect(
      resolveDatabaseConnectTimeouts({
        DATABASE_CONNECT_ATTEMPT_TIMEOUT_MS: "  ",
        DATABASE_CONNECT_DEADLINE_MS: "",
      }),
    ).toEqual({
      databaseConnectAttemptTimeoutMs: DATABASE_CONNECT_ATTEMPT_TIMEOUT_DEFAULT_MS,
      databaseConnectDeadlineMs: DATABASE_CONNECT_DEADLINE_DEFAULT_MS,
    });
  });

  it("accepts valid environment overrides within bounds", () => {
    expect(
      resolveDatabaseConnectTimeouts({
        DATABASE_CONNECT_ATTEMPT_TIMEOUT_MS: "10000",
        DATABASE_CONNECT_DEADLINE_MS: "25000",
      }),
    ).toEqual({
      databaseConnectAttemptTimeoutMs: 10_000,
      databaseConnectDeadlineMs: 25_000,
    });
  });

  it("rejects invalid strings, zero, negative, non-integer, and oversized values", () => {
    expect(() =>
      resolveDatabaseConnectTimeouts({ DATABASE_CONNECT_ATTEMPT_TIMEOUT_MS: "fast" }),
    ).toThrow(/QA68|positive integer/i);
    expect(() =>
      resolveDatabaseConnectTimeouts({ DATABASE_CONNECT_ATTEMPT_TIMEOUT_MS: "0" }),
    ).toThrow(/QA68|1–/);
    expect(() =>
      resolveDatabaseConnectTimeouts({ DATABASE_CONNECT_DEADLINE_MS: "-1" }),
    ).toThrow(/QA68|positive integer/i);
    expect(() =>
      resolveDatabaseConnectTimeouts({ DATABASE_CONNECT_DEADLINE_MS: "2000.5" }),
    ).toThrow(/QA68|positive integer/i);
    expect(() =>
      resolveDatabaseConnectTimeouts({
        DATABASE_CONNECT_ATTEMPT_TIMEOUT_MS: String(DATABASE_CONNECT_ATTEMPT_TIMEOUT_MAX_MS + 1),
      }),
    ).toThrow(/QA68|1–/);
    expect(() =>
      resolveDatabaseConnectTimeouts({
        DATABASE_CONNECT_DEADLINE_MS: String(DATABASE_CONNECT_DEADLINE_MAX_MS + 1),
      }),
    ).toThrow(/QA68|1–/);
  });

  it("rejects a deadline shorter than the attempt timeout", () => {
    expect(() =>
      resolveDatabaseConnectTimeouts({
        DATABASE_CONNECT_ATTEMPT_TIMEOUT_MS: "10000",
        DATABASE_CONNECT_DEADLINE_MS: "2000",
      }),
    ).toThrow(/QA68|greater than or equal/i);
  });

  it("does not put connection strings or credentials in configuration errors", () => {
    try {
      resolveDatabaseConnectTimeouts({
        DATABASE_URL_API: SECRET,
        DATABASE_CONNECT_ATTEMPT_TIMEOUT_MS: "nope",
      });
      throw new Error("expected configuration failure");
    } catch (error) {
      const text = error instanceof Error ? `${error.name}:${error.message}` : String(error);
      expect(text).toMatch(/QA68/);
      expect(text).not.toContain(SECRET);
      expect(text).not.toMatch(/postgres:\/\/|super-secret|db\.internal/i);
    }
  });
});
