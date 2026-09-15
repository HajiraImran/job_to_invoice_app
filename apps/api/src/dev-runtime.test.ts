import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function runNode(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: apiRoot,
      env: {
        APP_ENV: "development",
        NODE_OPTIONS: "",
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        windir: process.env.windir,
      },
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

describe("API development runtime", () => {
  it("loads the API TypeScript graph with transform-types and without ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX", async () => {
    const pkg = JSON.parse(readFileSync(join(apiRoot, "package.json"), "utf8")) as {
      scripts: { dev: string };
    };
    expect(pkg.scripts.dev).toBe("node --experimental-transform-types --watch src/index.ts");

    const result = await runNode([
      "--experimental-transform-types",
      "--eval",
      "await import('./src/app.ts'); await import('./src/jwt.ts');",
    ]);

    expect(result.stderr).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/);
    expect(result.code).toBe(0);
  });
});
