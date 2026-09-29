import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { portalDevEnvironment, windowsDefaultRouteAliases } from "../src/dev-origin.ts";

const portalRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const aliases = windowsDefaultRouteAliases();
const started = portalDevEnvironment(process.env, networkInterfaces(), aliases);
if (started.origin) {
  console.log(`portal origin ${started.origin}`);
} else {
  console.log("portal origin localhost");
}
console.log(`api base ${started.apiBase}`);

const nextBin = join(portalRoot, "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, "dev", "--hostname", "0.0.0.0", "--port", "3000"], {
  cwd: portalRoot,
  env: started.env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
