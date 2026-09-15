import Constants from "expo-constants";

export const PUBLIC_ENV_NAMES = [
  "EXPO_PUBLIC_API_BASE_URL",
  "EXPO_PUBLIC_AUTH_PROJECT_URL",
  "EXPO_PUBLIC_AUTH_PUBLISHABLE_KEY",
] as const;

export type PublicConfig = {
  apiBaseUrl: string;
  authProjectUrl: string;
  authPublishableKey: string;
};

function extraValue(key: string): string {
  const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string | undefined>;
  const value = extra[key];
  return typeof value === "string" ? value.trim() : "";
}

function envValue(name: (typeof PUBLIC_ENV_NAMES)[number], extraKey: string): string {
  const fromEnv = process.env[name];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return extraValue(extraKey);
}

function readRaw(): Record<(typeof PUBLIC_ENV_NAMES)[number], string> {
  return {
    EXPO_PUBLIC_API_BASE_URL: envValue("EXPO_PUBLIC_API_BASE_URL", "apiBaseUrl"),
    EXPO_PUBLIC_AUTH_PROJECT_URL: envValue("EXPO_PUBLIC_AUTH_PROJECT_URL", "authProjectUrl"),
    EXPO_PUBLIC_AUTH_PUBLISHABLE_KEY: envValue("EXPO_PUBLIC_AUTH_PUBLISHABLE_KEY", "authPublishableKey"),
  };
}

export function missingPublicEnvNames(): string[] {
  const raw = readRaw();
  return PUBLIC_ENV_NAMES.filter((name) => raw[name].length === 0);
}

export function publicConfig(): PublicConfig {
  const raw = readRaw();
  const missing = PUBLIC_ENV_NAMES.filter((name) => raw[name].length === 0);
  if (missing.length > 0) {
    throw new Error(`Mobile public configuration is incomplete. Set ${missing.join(", ")}.`);
  }
  return {
    apiBaseUrl: raw.EXPO_PUBLIC_API_BASE_URL,
    authProjectUrl: raw.EXPO_PUBLIC_AUTH_PROJECT_URL,
    authPublishableKey: raw.EXPO_PUBLIC_AUTH_PUBLISHABLE_KEY,
  };
}
