import { randomUUID as nodeRandomUUID } from "node:crypto";
import { vi } from "vitest";

vi.mock("expo-crypto", () => ({
  randomUUID: () => nodeRandomUUID(),
}));
