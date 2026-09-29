import { describe, expect, it } from "vitest";
import type { NetworkInterfaceInfo } from "node:os";
import {
  developmentAllowedDevOrigins,
  hostnameFromPortalOrigin,
  isVirtualAdapterName,
  portalDevEnvironment,
  selectLanIPv4,
} from "./dev-origin";

function iface(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: null,
  };
}

describe("portal development origin", () => {
  it("parses the portal hostname and ignores credentials", () => {
    expect(hostnameFromPortalOrigin("http://192.168.1.50:3000")).toBe("192.168.1.50");
    expect(hostnameFromPortalOrigin("http://user:secret@192.168.1.50:3000")).toBeUndefined();
    expect(hostnameFromPortalOrigin("not a url")).toBeUndefined();
  });

  it("allows only that hostname in development", () => {
    expect(
      developmentAllowedDevOrigins({
        NODE_ENV: "development",
        PORTAL_ORIGIN: "http://10.1.2.3:3000",
      }),
    ).toEqual(["10.1.2.3"]);
  });

  it("fills a loopback portal origin from the physical LAN adapter", () => {
    const env = { NODE_ENV: "development", PORTAL_ORIGIN: "http://localhost:3000" };
    expect(
      developmentAllowedDevOrigins(
        env,
        {
          Tailscale: [iface("100.64.0.8")],
          "Wi-Fi": [iface("192.168.8.15")],
        },
        ["Tailscale", "Wi-Fi"],
      ),
    ).toEqual(["192.168.8.15"]);
    expect(env.PORTAL_ORIGIN).toBe("http://192.168.8.15:3000");
  });

  it("does not add a development origin for production or staging", () => {
    expect(
      developmentAllowedDevOrigins(
        {
          NODE_ENV: "production",
          PORTAL_ORIGIN: "https://portal.example.com",
        },
        { "Wi-Fi": [iface("10.9.9.9")] },
      ),
    ).toBeUndefined();
    expect(
      developmentAllowedDevOrigins({
        NODE_ENV: "development",
        APP_ENV: "staging",
        PORTAL_ORIGIN: "https://portal.example.com",
      }),
    ).toBeUndefined();
  });

  it("skips VPN and virtual adapters and follows the physical default route", () => {
    expect(isVirtualAdapterName("Tailscale")).toBe(true);
    expect(isVirtualAdapterName("vEthernet (WSL)")).toBe(true);
    expect(isVirtualAdapterName("Wi-Fi")).toBe(false);
    const selected = selectLanIPv4(
      {
        Tailscale: [iface("100.64.0.8")],
        "vEthernet (WSL)": [iface("172.31.0.1")],
        "Ethernet 2": [iface("10.0.0.4")],
        "Wi-Fi": [iface("192.168.9.24")],
        Loopback: [iface("127.0.0.1", true)],
      },
      ["Tailscale", "NordLynx", "Wi-Fi"],
    );
    expect(selected).toBe("192.168.9.24");
  });

  it("sets the portal origin from the selected LAN host and keeps the API on port 3001", () => {
    const started = portalDevEnvironment(
      { API_BASE_URL: undefined, PORTAL_ORIGIN: "http://localhost:3000" },
      { "Wi-Fi": [iface("192.168.4.20")] },
    );
    expect(started.origin).toBe("http://192.168.4.20:3000");
    expect(started.apiBase).toBe("http://127.0.0.1:3001");
    expect(started.env.PORTAL_ORIGIN).toBe("http://192.168.4.20:3000");
  });
});
