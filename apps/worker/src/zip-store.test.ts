import { describe, expect, it } from "vitest";
import { buildStoredZip } from "./zip-store.ts";

describe("stored ZIP writer", () => {
  it("writes local, central, and end records for UTF-8 names", () => {
    const zip = buildStoredZip([
      { name: "README.txt", data: Buffer.from("hello", "utf8") },
      { name: "snapshots/doc.json", data: Buffer.from("{}", "utf8") },
    ]);
    expect(zip.subarray(0, 4).toString("binary")).toBe("PK\u0003\u0004");
    expect(zip.includes(Buffer.from("README.txt"))).toBe(true);
    expect(zip.includes(Buffer.from("snapshots/doc.json"))).toBe(true);
    expect(zip.includes(Buffer.from("PK\u0005\u0006", "binary"))).toBe(true);
  });
});
