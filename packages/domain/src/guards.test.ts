import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = dirname(fileURLToPath(import.meta.url));

describe("money engine source guards", () => {
  it("does not calculate money with binary floating point", () => {
    const files = readdirSync(srcDir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    for (const name of files) {
      const source = readFileSync(join(srcDir, name), "utf8");
      expect(source, name).not.toMatch(/\bMath\.round\b/);
      expect(source, name).not.toMatch(/\bMath\.floor\b/);
      expect(source, name).not.toMatch(/\bMath\.ceil\b/);
      expect(source, name).not.toMatch(/\bparseFloat\b/);
      expect(source, name).not.toMatch(/\bNumber\.parseFloat\b/);
      expect(source, name).not.toMatch(/\*\s*0\.01\b/);
      expect(source, name).not.toMatch(/\/\s*100\b/);
    }
  });
});
