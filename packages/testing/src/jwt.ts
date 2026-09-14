import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

export type JwtFixture = {
  issuer: string;
  audience: string;
  jwks: { keys: JWK[] };
  sign: (input: {
    sub: string;
    email?: string;
    role?: string;
    issuer?: string;
    audience?: string | string[];
    expiresIn?: string;
    expired?: boolean;
  }) => Promise<string>;
};

export async function createJwtFixture(): Promise<JwtFixture> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-owner-key";
  jwk.alg = "ES256";
  jwk.use = "sig";
  const issuer = "https://auth.test.jobtoinvoice.invalid/auth/v1";
  const audience = "authenticated";

  return {
    issuer,
    audience,
    jwks: { keys: [jwk] },
    sign: async (input) => {
      const now = Math.floor(Date.now() / 1000);
      const jwt = new SignJWT({
        email: input.email,
        role: input.role ?? "authenticated",
      });
      jwt.setProtectedHeader({ alg: "ES256", kid: "test-owner-key", typ: "JWT" });
      jwt.setSubject(input.sub);
      jwt.setIssuer(input.issuer ?? issuer);
      jwt.setAudience(input.audience ?? audience);
      jwt.setIssuedAt(now);
      if (input.expired) {
        jwt.setExpirationTime(now - 60);
      } else {
        jwt.setExpirationTime(input.expiresIn ?? "5m");
      }
      return jwt.sign(privateKey);
    },
  };
}
