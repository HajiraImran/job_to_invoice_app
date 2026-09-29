import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";
import { developmentAllowedDevOrigins, windowsDefaultRouteAliases } from "./src/dev-origin.ts";

const scriptPolicy =
  process.env.APP_ENV === "development" || process.env.NODE_ENV === "development"
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self'";

const csp = [
  "default-src 'self'",
  scriptPolicy,
  "connect-src 'self'",
  "img-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const allowedDevOrigins = developmentAllowedDevOrigins(
  process.env,
  networkInterfaces(),
  windowsDefaultRouteAliases(),
);
if (allowedDevOrigins?.[0]) {
  console.log(`portal origin ${process.env.PORTAL_ORIGIN ?? `http://${allowedDevOrigins[0]}:3000`}`);
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(allowedDevOrigins ? { allowedDevOrigins } : {}),
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
