import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { LoadedApiEnv, LoadedEnv } from "@job-to-invoice/config";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type VerifiedAccess = {
  sub: string;
  email: string;
  role: string;
  authTime?: number;
};

export class JwtVerificationError extends Error {
  constructor(message = "Could not verify your session.") {
    super(message);
    this.name = "JwtVerificationError";
  }
}

export type JwtVerifier = (token: string) => Promise<VerifiedAccess>;

function readEmail(payload: JWTPayload): string | undefined {
  if (typeof payload.email === "string" && payload.email.length > 0) {
    return payload.email;
  }
  const claims = payload as Record<string, unknown>;
  const meta = claims.user_metadata;
  if (meta && typeof meta === "object" && "email" in meta && typeof meta.email === "string") {
    return meta.email;
  }
  return undefined;
}

const FRESH_OTP_AMR_METHODS = new Set(["otp", "magiclink", "email"]);

/** Unix seconds. Hosted Supabase access tokens expose OTP time on `amr`, not `auth_time`. */
export function readAccessAuthTime(payload: JWTPayload): number | undefined {
  const claims = payload as Record<string, unknown>;
  const times: number[] = [];
  if (typeof claims.auth_time === "number" && Number.isFinite(claims.auth_time)) {
    times.push(Math.floor(claims.auth_time));
  }
  if (Array.isArray(claims.amr)) {
    for (const entry of claims.amr) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.method !== "string" || !FRESH_OTP_AMR_METHODS.has(record.method)) {
        continue;
      }
      if (typeof record.timestamp !== "number" || !Number.isFinite(record.timestamp)) {
        continue;
      }
      times.push(Math.floor(record.timestamp));
    }
  }
  if (times.length === 0) {
    return undefined;
  }
  return Math.max(...times);
}

function asAccess(payload: JWTPayload): VerifiedAccess {
  if (typeof payload.sub !== "string" || !UUID.test(payload.sub)) {
    throw new JwtVerificationError();
  }
  const role = typeof payload.role === "string" ? payload.role : "";
  if (role !== "authenticated") {
    throw new JwtVerificationError();
  }
  const email = readEmail(payload);
  if (!email) {
    throw new JwtVerificationError();
  }
  const authTime = readAccessAuthTime(payload);
  return { sub: payload.sub, email, role, authTime };
}

export function createJwtVerifier(options: {
  issuer: string;
  audience: string;
  jwks?: { keys: object[] };
  jwksUrl?: string;
}): JwtVerifier {
  const keySet = options.jwksUrl
    ? createRemoteJWKSet(new URL(options.jwksUrl))
    : createLocalJWKSet(options.jwks as Parameters<typeof createLocalJWKSet>[0]);

  return async (token: string) => {
    try {
      const { payload } = await jwtVerify(token, keySet, {
        issuer: options.issuer,
        audience: options.audience,
        clockTolerance: 5,
      });
      return asAccess(payload);
    } catch (error) {
      if (error instanceof JwtVerificationError) {
        throw error;
      }
      throw new JwtVerificationError();
    }
  };
}

export function jwtVerifierFromEnv(env: LoadedEnv | LoadedApiEnv): JwtVerifier | undefined {
  const issuer =
    "AUTH_ISSUER" in env && env.AUTH_ISSUER
      ? env.AUTH_ISSUER
      : env.AUTH_PROJECT_URL
        ? `${env.AUTH_PROJECT_URL.replace(/\/$/, "")}/auth/v1`
        : undefined;
  const audience = "AUTH_AUDIENCE" in env && env.AUTH_AUDIENCE ? env.AUTH_AUDIENCE : "authenticated";
  const jwksJson = "AUTH_JWKS_JSON" in env ? env.AUTH_JWKS_JSON : undefined;
  if (!issuer) {
    return undefined;
  }
  if (jwksJson) {
    return createJwtVerifier({
      issuer,
      audience,
      jwks: JSON.parse(jwksJson) as { keys: object[] },
    });
  }
  if (env.AUTH_PROJECT_URL) {
    return createJwtVerifier({
      issuer,
      audience,
      jwksUrl: `${env.AUTH_PROJECT_URL.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`,
    });
  }
  return undefined;
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}
