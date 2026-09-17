import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const COOKIE = "jti_portal";

function apiBase(): string {
  return (process.env.API_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");
}

function portalOrigin(): string {
  return (process.env.PORTAL_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
}

function cookieSecure(): boolean {
  const env = process.env.APP_ENV ?? "development";
  return env === "production" || env === "staging" || portalOrigin().startsWith("https://");
}

async function forward(request: NextRequest, path: string[]): Promise<NextResponse> {
  const target = `${apiBase()}/v1/portal/${path.join("/")}`;
  const headers = new Headers();
  headers.set("content-type", request.headers.get("content-type") ?? "application/json");
  headers.set("origin", portalOrigin());
  const cookie = request.headers.get("cookie");
  if (cookie) {
    headers.set("cookie", cookie);
  }
  const csrf = request.headers.get("x-csrf-token");
  if (csrf) {
    headers.set("x-csrf-token", csrf);
  }
  const idempotency = request.headers.get("idempotency-key");
  if (idempotency) {
    headers.set("idempotency-key", idempotency);
  }
  const init: RequestInit = {
    method: request.method,
    headers,
    cache: "no-store",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.text();
  }
  const response = await fetch(target, init);
  const json = (await response.json()) as Record<string, unknown>;
  const data = json.data && typeof json.data === "object" ? (json.data as Record<string, unknown>) : undefined;
  let session: string | undefined;
  let maxAge = 0;
  if (data && typeof data.session === "string") {
    session = data.session;
    delete data.session;
  }
  if (data && typeof data.max_age_sec === "number") {
    maxAge = data.max_age_sec;
  }
  const out = NextResponse.json(json, {
    status: response.status,
    headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
  if (session && maxAge > 0) {
    out.cookies.set(COOKIE, session, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge,
      secure: cookieSecure(),
    });
  }
  return out;
}

export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return forward(request, path);
}

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return forward(request, path);
}
