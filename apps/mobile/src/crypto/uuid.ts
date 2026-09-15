import { randomUUID } from "expo-crypto";

export function secureRandomUUID(): string {
  return randomUUID();
}
