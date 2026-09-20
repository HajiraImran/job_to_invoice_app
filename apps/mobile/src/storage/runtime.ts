import Constants from "expo-constants";
import { Platform } from "react-native";
import { classifyEncryptedStorageCapability, type EncryptedStorageCapability } from "./capability.ts";
import type { EncryptedSqliteBridge } from "./encrypted-database.ts";

/**
 * Runtime helpers that touch Expo/React Native.
 * Keep out of pure unit tests; inject capability + bridge instead.
 */

export function defaultEncryptedStorageCapability(): EncryptedStorageCapability {
  return classifyEncryptedStorageCapability({
    platform: Platform.OS,
    appOwnership: Constants.appOwnership,
    executionEnvironment: Constants.executionEnvironment,
  });
}

/** Production bridge wrapping expo-sqlite. Call only from native-capable code paths. */
export async function createExpoSqliteBridge(): Promise<EncryptedSqliteBridge> {
  const sqlite = await import("expo-sqlite");
  return {
    openDatabaseAsync: async (databaseName) => {
      const db = await sqlite.openDatabaseAsync(databaseName);
      return {
        execAsync: (source) => db.execAsync(source),
        runAsync: (source, params) =>
          db.runAsync(source, ...(params ?? []) as Array<string | number | null | Uint8Array>),
        getFirstAsync: (source, params) =>
          db.getFirstAsync(source, ...(params ?? []) as Array<string | number | null | Uint8Array>),
        closeAsync: () => db.closeAsync(),
      };
    },
    deleteDatabaseAsync: (databaseName) => sqlite.deleteDatabaseAsync(databaseName),
  };
}
