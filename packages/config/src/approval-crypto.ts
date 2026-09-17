import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const DELIVERY_ALGORITHM = "aes-256-gcm";
export const TOKEN_BYTES = 32;
export const NONCE_BYTES = 12;
export const GCM_TAG_BYTES = 16;

export type VersionedSecret = {
  version: number;
  material: Buffer;
};

const VERSION_PREFIX = /^v([1-9]\d*):(.+)$/;

export function parseVersionedSecret(name: string, value: string): VersionedSecret {
  const trimmed = value.trim();
  if (trimmed.length < 16) {
    throw new Error(`Invalid ${name} configuration (QA68): value is too short`);
  }
  const matched = VERSION_PREFIX.exec(trimmed);
  if (matched?.[1] && matched[2]) {
    return { version: Number(matched[1]), material: Buffer.from(matched[2], "utf8") };
  }
  return { version: 1, material: Buffer.from(trimmed, "utf8") };
}

export function aes256Key(material: Buffer): Buffer {
  return createHash("sha256").update(material).digest();
}

export function generateApprovalToken(): Buffer {
  return randomBytes(TOKEN_BYTES);
}

export function encodeFragmentToken(token: Buffer): string {
  if (token.length !== TOKEN_BYTES) {
    throw new Error("Approval token must be 256 bits");
  }
  return token.toString("base64url");
}

export function hashApprovalToken(token: Buffer, secret: VersionedSecret): { hash: string; keyVersion: number } {
  const digest = createHmac("sha256", secret.material).update(token).digest("hex");
  return { hash: digest, keyVersion: secret.version };
}

export type EncryptedDeliveryPayload = {
  algorithm: typeof DELIVERY_ALGORITHM;
  keyVersion: number;
  nonce: Buffer;
  ciphertext: Buffer;
};

export function encryptDeliveryToken(token: Buffer, secret: VersionedSecret, nonce = randomBytes(NONCE_BYTES)): EncryptedDeliveryPayload {
  if (token.length !== TOKEN_BYTES) {
    throw new Error("Approval token must be 256 bits");
  }
  if (nonce.length !== NONCE_BYTES) {
    throw new Error("Delivery nonce must be 12 bytes");
  }
  const cipher = createCipheriv(DELIVERY_ALGORITHM, aes256Key(secret.material), nonce);
  const encrypted = Buffer.concat([cipher.update(token), cipher.final(), cipher.getAuthTag()]);
  return {
    algorithm: DELIVERY_ALGORITHM,
    keyVersion: secret.version,
    nonce,
    ciphertext: encrypted,
  };
}

export function decryptDeliveryToken(payload: EncryptedDeliveryPayload, secret: VersionedSecret): Buffer {
  if (payload.algorithm !== DELIVERY_ALGORITHM) {
    throw new Error("Unsupported delivery algorithm");
  }
  if (payload.nonce.length !== NONCE_BYTES || payload.ciphertext.length < GCM_TAG_BYTES + 1) {
    throw new Error("Invalid delivery payload");
  }
  const tag = payload.ciphertext.subarray(payload.ciphertext.length - GCM_TAG_BYTES);
  const data = payload.ciphertext.subarray(0, payload.ciphertext.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv(DELIVERY_ALGORITHM, aes256Key(secret.material), payload.nonce);
  decipher.setAuthTag(tag);
  const token = Buffer.concat([decipher.update(data), decipher.final()]);
  if (token.length !== TOKEN_BYTES) {
    throw new Error("Invalid delivery payload");
  }
  return token;
}

export function encryptRecipientEmail(email: string, secret: VersionedSecret, nonce = randomBytes(NONCE_BYTES)): EncryptedDeliveryPayload {
  return encryptUtf8(email, secret, nonce);
}

export function encryptUtf8(value: string, secret: VersionedSecret, nonce = randomBytes(NONCE_BYTES)): EncryptedDeliveryPayload {
  if (nonce.length !== NONCE_BYTES) {
    throw new Error("Delivery nonce must be 12 bytes");
  }
  const cipher = createCipheriv(DELIVERY_ALGORITHM, aes256Key(secret.material), nonce);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return {
    algorithm: DELIVERY_ALGORITHM,
    keyVersion: secret.version,
    nonce,
    ciphertext: encrypted,
  };
}

export function decryptUtf8(payload: EncryptedDeliveryPayload, secret: VersionedSecret): string {
  if (payload.algorithm !== DELIVERY_ALGORITHM) {
    throw new Error("Unsupported delivery algorithm");
  }
  if (payload.nonce.length !== NONCE_BYTES || payload.ciphertext.length < GCM_TAG_BYTES + 1) {
    throw new Error("Invalid delivery payload");
  }
  const tag = payload.ciphertext.subarray(payload.ciphertext.length - GCM_TAG_BYTES);
  const data = payload.ciphertext.subarray(0, payload.ciphertext.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv(DELIVERY_ALGORITHM, aes256Key(secret.material), payload.nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function hashOtp(code: string, secret: VersionedSecret): { hash: string; keyVersion: number } {
  const digest = createHmac("sha256", secret.material).update(code, "utf8").digest("hex");
  return { hash: digest, keyVersion: secret.version };
}

export function hashSessionSecret(raw: Buffer, secret: VersionedSecret): { hash: string; keyVersion: number } {
  if (raw.length !== TOKEN_BYTES) {
    throw new Error("Session secret must be 256 bits");
  }
  const digest = createHmac("sha256", secret.material).update(raw).digest("hex");
  return { hash: digest, keyVersion: secret.version };
}

export function encodeSessionSecret(raw: Buffer): string {
  if (raw.length !== TOKEN_BYTES) {
    throw new Error("Session secret must be 256 bits");
  }
  return raw.toString("base64url");
}

export function decodeFragmentToken(value: string): Buffer | undefined {
  if (typeof value !== "string" || value.length < 40 || value.length > 64) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length !== TOKEN_BYTES) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

export function buffersEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
