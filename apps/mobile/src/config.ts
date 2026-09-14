import Constants from "expo-constants";

export function publicConfig() {
  const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string | undefined>;
  return {
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? extra.apiBaseUrl ?? "http://localhost:3001",
    authProjectUrl: process.env.EXPO_PUBLIC_AUTH_PROJECT_URL ?? extra.authProjectUrl ?? "",
    authPublishableKey: process.env.EXPO_PUBLIC_AUTH_PUBLISHABLE_KEY ?? extra.authPublishableKey ?? "",
  };
}
