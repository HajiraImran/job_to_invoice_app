/**
 * Runtime capability for SYNC01 encrypted SQLite.
 * Expo Go (appOwnership === "expo") cannot verify SQLCipher.
 * Native development / standalone builds are candidates; device tests still required.
 */

export type EncryptedStorageCapability =
  | { supported: true; kind: "sqlcipher_native" }
  | { supported: false; code: "UNSUPPORTED_RUNTIME" };

export type RuntimeHints = {
  platform: string;
  /** Constants.appOwnership — "expo" means Expo Go. */
  appOwnership: string | null | undefined;
  /** Constants.executionEnvironment */
  executionEnvironment: string | null | undefined;
};

export function classifyEncryptedStorageCapability(hints: RuntimeHints): EncryptedStorageCapability {
  if (hints.platform === "web") {
    return { supported: false, code: "UNSUPPORTED_RUNTIME" };
  }
  if (hints.appOwnership === "expo") {
    return { supported: false, code: "UNSUPPORTED_RUNTIME" };
  }
  return { supported: true, kind: "sqlcipher_native" };
}
