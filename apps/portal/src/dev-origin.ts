import { execFileSync } from "node:child_process";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

const VIRTUAL_ADAPTER =
  /vethernet|hyper-v|\bwsl\b|vmware|virtualbox|vbox|tailscale|nordlynx|wireguard|wintun|zerotier|hamachi|docker|loopback|bluetooth|npcap|\bvpn\b|\bvirtual\b|\btunnel\b|pseudo-interface|isatap|teredo/i;

const PHYSICAL_ADAPTER = /^(wi-?fi|wlan|ethernet)( \d+)?$/i;

export function isVirtualAdapterName(name: string): boolean {
  return VIRTUAL_ADAPTER.test(name);
}

export function hostnameFromPortalOrigin(origin: string | undefined): string | undefined {
  if (!origin) {
    return undefined;
  }
  try {
    const url = new URL(origin);
    if (url.username || url.password) {
      return undefined;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.hostname || undefined;
  } catch {
    return undefined;
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function windowsDefaultRouteAliases(): string[] {
  if (process.platform !== "win32") {
    return [];
  }
  try {
    const stdout = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric,InterfaceMetric | Select-Object -ExpandProperty InterfaceAlias",
      ],
      { timeout: 8000, windowsHide: true, encoding: "utf8" },
    );
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

export function developmentAllowedDevOrigins(
  env: Record<string, string | undefined>,
  interfaces?: Record<string, NetworkInterfaceInfo[] | undefined>,
  routeAliases: readonly string[] = [],
): string[] | undefined {
  if (env.NODE_ENV === "production" || env.APP_ENV === "production" || env.APP_ENV === "staging") {
    return undefined;
  }
  const configured = hostnameFromPortalOrigin(env.PORTAL_ORIGIN);
  if (configured && !isLoopbackHostname(configured)) {
    return [configured];
  }
  if (!interfaces) {
    return undefined;
  }
  const host = selectLanIPv4(interfaces, routeAliases);
  if (!host) {
    return undefined;
  }
  env.PORTAL_ORIGIN = `http://${host}:3000`;
  return [host];
}

export function isPrivateLanIPv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = numbers;
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

export function physicalRouteAliases(aliases: readonly string[]): string[] {
  return aliases.map((alias) => alias.trim()).filter((alias) => alias.length > 0 && !isVirtualAdapterName(alias));
}

export function selectLanIPv4(
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined>,
  routeAliases: readonly string[] = [],
): string | undefined {
  const candidates: { name: string; address: string }[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (isVirtualAdapterName(name)) {
      continue;
    }
    for (const entry of entries ?? []) {
      const ipv4 = entry.family === "IPv4";
      if (!ipv4 || entry.internal || !isPrivateLanIPv4(entry.address)) {
        continue;
      }
      candidates.push({ name, address: entry.address });
    }
  }
  for (const alias of physicalRouteAliases(routeAliases)) {
    const match = candidates.find((candidate) => candidate.name.toLowerCase() === alias.toLowerCase());
    if (match) {
      return match.address;
    }
  }
  const named = candidates.find((candidate) => PHYSICAL_ADAPTER.test(candidate.name));
  return named?.address ?? candidates[0]?.address;
}

export function currentLanIPv4(routeAliases: readonly string[] = []): string | undefined {
  return selectLanIPv4(networkInterfaces(), routeAliases);
}

export function portalDevEnvironment(
  env: Record<string, string | undefined>,
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined>,
  routeAliases: readonly string[] = [],
): { env: Record<string, string | undefined>; origin: string | undefined; apiBase: string } {
  const next: Record<string, string | undefined> = { ...env };
  if (!next.API_BASE_URL) {
    next.API_BASE_URL = "http://127.0.0.1:3001";
  }
  const host = selectLanIPv4(interfaces, routeAliases);
  if (host) {
    next.PORTAL_ORIGIN = `http://${host}:3000`;
  }
  return {
    env: next,
    origin: next.PORTAL_ORIGIN,
    apiBase: next.API_BASE_URL ?? "http://127.0.0.1:3001",
  };
}
