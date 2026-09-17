import { describe, expect, it } from "vitest";
import {
  DELIVERY_ALGORITHM,
  decryptDeliveryToken,
  decryptUtf8,
  encodeFragmentToken,
  encryptDeliveryToken,
  encryptRecipientEmail,
  encryptUtf8,
  generateApprovalToken,
  hashApprovalToken,
  hashOtp,
  parseVersionedSecret,
} from "./approval-crypto.ts";

describe("approval delivery crypto", () => {
  it("hashes a 256-bit token with a versioned HMAC key", () => {
    const token = generateApprovalToken();
    expect(token).toHaveLength(32);
    const secret = parseVersionedSecret("APPROVAL_TOKEN_HASH_KEY", "v2:hash-material-for-tests");
    const hashed = hashApprovalToken(token, secret);
    expect(hashed.keyVersion).toBe(2);
    expect(hashed.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed.hash).not.toBe(token.toString("hex"));
    expect(encodeFragmentToken(token)).not.toContain("+");
    expect(encodeFragmentToken(token)).not.toContain("/");
    expect(JSON.stringify({ hash: hashed.hash })).not.toContain("@");
  });

  it("round-trips AES-256-GCM token ciphertext with a 12-byte nonce", () => {
    const token = generateApprovalToken();
    const secret = parseVersionedSecret("APPROVAL_DELIVERY_ENCRYPTION_KEY", "delivery-key-material-ok");
    const encrypted = encryptDeliveryToken(token, secret);
    expect(encrypted.algorithm).toBe(DELIVERY_ALGORITHM);
    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.keyVersion).toBe(1);
    const decrypted = decryptDeliveryToken(encrypted, secret);
    expect(Buffer.compare(token, decrypted)).toBe(0);
  });

  it("encrypts recipient email separately from the token", () => {
    const secret = parseVersionedSecret("APPROVAL_DELIVERY_ENCRYPTION_KEY", "delivery-key-material-ok");
    const encrypted = encryptRecipientEmail("owner@jobtoinvoice.test", secret);
    expect(encrypted.ciphertext.includes(Buffer.from("owner@jobtoinvoice.test"))).toBe(false);
  });

  it("hashes OTP codes and round-trips UTF-8 delivery payloads", () => {
    const otp = parseVersionedSecret("OTP_HASH_KEY", "otp-hash-key-material-ok");
    const hashed = hashOtp("123456", otp);
    expect(hashed.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed.hash).not.toContain("123456");
    const delivery = parseVersionedSecret("APPROVAL_DELIVERY_ENCRYPTION_KEY", "delivery-key-material-ok");
    const encrypted = encryptUtf8("123456", delivery);
    expect(decryptUtf8(encrypted, delivery)).toBe("123456");
    expect(encrypted.ciphertext.includes(Buffer.from("123456"))).toBe(false);
  });
});
