import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: {} } },
}));

import { missingPublicEnvNames, publicConfig } from "./config.ts";

const NAMES = [
  "EXPO_PUBLIC_API_BASE_URL",
  "EXPO_PUBLIC_AUTH_PROJECT_URL",
  "EXPO_PUBLIC_AUTH_PUBLISHABLE_KEY",
] as const;

const previous: Record<string, string | undefined> = {};

function setPublicEnv(values: Partial<Record<(typeof NAMES)[number], string | undefined>>) {
  for (const name of NAMES) {
    previous[name] = process.env[name];
    process.env[name] = values[name] ?? "";
  }
}

afterEach(() => {
  for (const name of NAMES) {
    process.env[name] = previous[name] ?? "";
  }
});

describe("public mobile configuration", () => {
  it("lists missing EXPO_PUBLIC names without requiring values", () => {
    setPublicEnv({});
    expect(missingPublicEnvNames()).toEqual([...NAMES]);
  });

  it("accepts complete public configuration and does not echo values in errors", () => {
    setPublicEnv({
      EXPO_PUBLIC_API_BASE_URL: "http://10.0.0.2:3001",
      EXPO_PUBLIC_AUTH_PROJECT_URL: "https://auth.example.test",
      EXPO_PUBLIC_AUTH_PUBLISHABLE_KEY: "publishable-test-key",
    });
    expect(missingPublicEnvNames()).toEqual([]);
    const config = publicConfig();
    expect(config.apiBaseUrl).toBe("http://10.0.0.2:3001");
  });

  it("throws a configuration error that names variables but not their values", () => {
    setPublicEnv({
      EXPO_PUBLIC_API_BASE_URL: "http://10.0.0.2:3001",
      EXPO_PUBLIC_AUTH_PROJECT_URL: undefined,
      EXPO_PUBLIC_AUTH_PUBLISHABLE_KEY: "secret-must-not-appear",
    });
    expect(missingPublicEnvNames()).toEqual(["EXPO_PUBLIC_AUTH_PROJECT_URL"]);
    expect(() => publicConfig()).toThrow(/EXPO_PUBLIC_AUTH_PROJECT_URL/);
    try {
      publicConfig();
    } catch (error) {
      const message = String(error);
      expect(message).not.toContain("secret-must-not-appear");
      expect(message).not.toContain("http://10.0.0.2:3001");
    }
  });
});
