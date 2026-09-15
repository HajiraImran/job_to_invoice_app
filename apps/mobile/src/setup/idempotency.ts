import { secureRandomUUID } from "../crypto/uuid.ts";

export function createSetupIdempotencyKey(): string {
  return secureRandomUUID();
}

export function retainOrCreateSetupIdempotencyKey(current: string | undefined): string {
  return current ?? createSetupIdempotencyKey();
}
