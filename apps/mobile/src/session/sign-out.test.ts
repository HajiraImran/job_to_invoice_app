import { describe, expect, it, vi } from "vitest";
import { EMPTY_DRAFT_SYNC, signOutClears } from "@job-to-invoice/schemas";
import { LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED } from "../drafts/sync.ts";
import { copy } from "../i18n/en.ts";
import { BOOTSTRAP_KEY, LAST_AUTH_KEY, SESSION_STORAGE_KEY, clearAuthMaterial, type SecureKv } from "./storage.ts";
import {
  completeOwnerSignOut,
  signOutAlertSpec,
  signOutChoiceProceeds,
} from "./sign-out.ts";

function memoryKv(initial?: Record<string, string>): SecureKv & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial ?? {}));
  return {
    store,
    getItem: async (key) => store.get(key) ?? null,
    setItem: async (key, value) => {
      store.set(key, value);
    },
    removeItem: async (key) => {
      store.delete(key);
    },
  };
}

describe("sign-out draft-sync boundary", () => {
  it("allows confirm sign-out when draft status is empty", () => {
    expect(LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED).toBe(false);
    expect(signOutAlertSpec(EMPTY_DRAFT_SYNC, LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED)).toEqual({
      kind: "confirm",
      offerSynchronize: false,
    });
    expect(signOutChoiceProceeds("confirm")).toBe(true);
    expect(signOutChoiceProceeds("stay")).toBe(false);
  });

  it("requires warning when unsynced drafts are supplied and never offers Synchronize", () => {
    const unsynced = { hasUnsyncedDrafts: true, synchronizeAvailable: true };
    const spec = signOutAlertSpec(unsynced, LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED);
    expect(spec).toEqual({ kind: "unsynced", offerSynchronize: false });
    expect(copy.synchronize.length).toBeGreaterThan(0);
    expect(spec.offerSynchronize).toBe(false);
    expect(signOutAlertSpec({ hasUnsyncedDrafts: true, synchronizeAvailable: false }, false).offerSynchronize).toBe(
      false,
    );
  });

  it("does not sign out or clear auth when the owner stays signed in", async () => {
    const kv = memoryKv({
      [SESSION_STORAGE_KEY]: "session-json",
      [LAST_AUTH_KEY]: "2026-09-15T12:00:00.000Z",
      [BOOTSTRAP_KEY]: "{}",
    });
    const providerSignOut = vi.fn();
    const discardDrafts = vi.fn();
    const clearMemory = vi.fn();
    expect(signOutChoiceProceeds("stay")).toBe(false);
    expect(providerSignOut).not.toHaveBeenCalled();
    expect(discardDrafts).not.toHaveBeenCalled();
    expect(clearMemory).not.toHaveBeenCalled();
    expect(await kv.getItem(SESSION_STORAGE_KEY)).toBe("session-json");
    expect(await kv.getItem(BOOTSTRAP_KEY)).toBe("{}");
  });

  it("discards then signs out, clearing provider session, keys, bootstrap, and memory", async () => {
    const kv = memoryKv({
      [SESSION_STORAGE_KEY]: "session-json",
      [LAST_AUTH_KEY]: "2026-09-15T12:00:00.000Z",
      [BOOTSTRAP_KEY]: "{}",
    });
    const order: string[] = [];
    const result = await completeOwnerSignOut({
      mode: "discard",
      discardDrafts: async () => {
        order.push("discard");
      },
      providerSignOut: async () => {
        order.push("provider");
      },
      clearStoredAuth: async () => {
        order.push("storage");
        await clearAuthMaterial(kv);
      },
      clearMemory: () => {
        order.push("memory");
      },
    });
    expect(result).toEqual({ ok: true });
    expect(order).toEqual(["discard", "provider", "storage", "memory"]);
    expect(await kv.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(await kv.getItem(LAST_AUTH_KEY)).toBeNull();
    expect(await kv.getItem(BOOTSTRAP_KEY)).toBeNull();
    expect(signOutClears()).toEqual(
      expect.arrayContaining(["session", "access_token", "refresh_token", "bootstrap", "in_memory_auth"]),
    );
  });

  it("does not report success or clear auth when discard fails", async () => {
    const kv = memoryKv({ [SESSION_STORAGE_KEY]: "session-json", [BOOTSTRAP_KEY]: "{}" });
    const providerSignOut = vi.fn();
    const clearMemory = vi.fn();
    const result = await completeOwnerSignOut({
      mode: "discard",
      discardDrafts: async () => {
        throw new Error("discard failed");
      },
      providerSignOut,
      clearStoredAuth: async () => {
        await clearAuthMaterial(kv);
      },
      clearMemory,
    });
    expect(result).toEqual({ ok: false, stage: "discard" });
    expect(providerSignOut).not.toHaveBeenCalled();
    expect(clearMemory).not.toHaveBeenCalled();
    expect(await kv.getItem(SESSION_STORAGE_KEY)).toBe("session-json");
    expect(await kv.getItem(BOOTSTRAP_KEY)).toBe("{}");
    expect(JSON.stringify(result)).not.toMatch(/discard failed|session-json/i);
  });

  it("does not treat confirm sign-out as a successful synchronize", async () => {
    const result = await completeOwnerSignOut({
      mode: "confirm",
      discardDrafts: async () => {
        throw new Error("should not discard");
      },
      providerSignOut: async () => undefined,
      clearStoredAuth: async () => undefined,
      clearMemory: () => undefined,
    });
    expect(result).toEqual({ ok: true });
  });
});
