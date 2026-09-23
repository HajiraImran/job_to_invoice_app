import { describe, expect, it, vi } from "vitest";
import { processPurgeAccount } from "./purge.ts";

function scriptedPool(claimRows: unknown[]) {
  let claimed = false;
  return {
    connect: async () => ({
      query: vi.fn(async (sql: string) => {
        if (typeof sql === "string" && sql.includes("claim_purge_account")) {
          if (claimed) {
            return { rows: [] };
          }
          claimed = true;
          return { rows: claimRows };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    }),
  };
}

describe("account purge", () => {
  it("deletes claimed object keys then completes as purge_app", async () => {
    const deleted: string[] = [];
    const result = await processPurgeAccount({
      pool: scriptedPool([
        {
          id: "11111111-1111-4111-8111-111111111111",
          workspace_id: "22222222-2222-4222-8222-222222222222",
          owner_id: "33333333-3333-4333-8333-333333333333",
          object_keys: ["ws/a.pdf", "ws/export.zip"],
        },
      ]) as never,
      store: {
        deleteObject: async (key) => {
          deleted.push(key);
        },
      },
    });
    expect(result).toBe("done");
    expect(deleted).toEqual(["ws/a.pdf", "ws/export.zip"]);
  });

  it("returns idle when nothing is due", async () => {
    const result = await processPurgeAccount({
      pool: scriptedPool([]) as never,
      store: { deleteObject: async () => undefined },
    });
    expect(result).toBe("idle");
  });
});
