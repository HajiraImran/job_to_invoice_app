import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { alignDevelopmentStorageEnv } from "@job-to-invoice/config";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function isLoopbackOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function isPrivateLanIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const first = numbers[0];
  const second = numbers[1];
  if (first === undefined || second === undefined) {
    return false;
  }
  if (first === 10) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  return first === 172 && second >= 16 && second <= 31;
}

function selectedLanHost(): string | undefined {
  const moduleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "../../portal/src/dev-origin.ts")).href;
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `import { currentLanIPv4, windowsDefaultRouteAliases } from ${JSON.stringify(moduleUrl)}; const host = currentLanIPv4(windowsDefaultRouteAliases()); if (host) process.stdout.write(host);`,
      ],
      { encoding: "utf8", timeout: 8000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return isPrivateLanIPv4(stdout) ? stdout : undefined;
  } catch {
    return undefined;
  }
}

const appEnv = process.env.APP_ENV ?? "development";
if (appEnv !== "production" && appEnv !== "staging" && process.env.NODE_ENV !== "production") {
  let lanHost: string | undefined | null = null;
  const lan = () => (lanHost === null ? (lanHost = selectedLanHost()) : lanHost);
  const current = process.env.PORTAL_ORIGIN;
  if (!current || isLoopbackOrigin(current)) {
    const host = lan();
    if (host) {
      process.env.PORTAL_ORIGIN = `http://${host}:3000`;
      process.stdout.write(`api portal origin ${process.env.PORTAL_ORIGIN}\n`);
    }
  }
  if (process.env.STORAGE_ENDPOINT) {
    const localAddresses = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .filter((entry) => entry.family === "IPv4")
      .map((entry) => entry.address);
    const changes = alignDevelopmentStorageEnv(process.env, { localAddresses, lanHost: lan() });
    if (changes.includes("download_lan")) {
      process.stdout.write(`api storage download host ${new URL(process.env.STORAGE_DOWNLOAD_ENDPOINT ?? "").host}\n`);
    }
  }
}
