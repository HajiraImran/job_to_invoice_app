import { describe, expect, it } from "vitest";
import { loadEnv, r2DocumentsBucket } from "./env.ts";

describe("loadEnv", () => {
  it("accepts development with local defaults", () => {
    const env = loadEnv({ APP_ENV: "development" });
    expect(env.APP_ENV).toBe("development");
    expect(env.API_BASE_URL).toContain("localhost");
  });

  it("defaults private R2 buckets and requires staging to set the name", () => {
    expect(r2DocumentsBucket("development")).toBe("job-to-invoice-documents-development");
    expect(r2DocumentsBucket("production")).toBe("job-to-invoice-documents-production");
    expect(r2DocumentsBucket("staging", "job-to-invoice-documents-staging")).toBe(
      "job-to-invoice-documents-staging",
    );
    expect(() => r2DocumentsBucket("staging")).toThrow(/R2_DOCUMENTS_BUCKET/);
  });

  it("rejects production when mandatory secrets are empty", () => {
    expect(() => loadEnv({ APP_ENV: "production" })).toThrow(/QA68/);
  });

  it("rejects production placeholder secrets", () => {
    expect(() =>
      loadEnv({
        APP_ENV: "production",
        PUBLIC_APP_NAME: "Job to Invoice",
        SUPPORT_URL: "https://support.example.com",
        OWNER_APP_BUNDLE_ID: "com.placeholder.jobtoinvoice",
        API_BASE_URL: "https://api.example.com",
        PORTAL_ORIGIN: "https://portal.example.com",
        AUTH_PROJECT_URL: "https://auth.example.com",
        AUTH_PUBLISHABLE_KEY: "changeme",
        AUTH_ISSUER: "https://issuer.example.com",
        AUTH_AUDIENCE: "api",
        DATABASE_URL_API: "postgres://api",
        DATABASE_URL_WORKER: "postgres://worker",
        DATABASE_URL_PURGE: "postgres://purge",
        DATABASE_URL_MIGRATIONS: "postgres://migrator",
        APPROVAL_TOKEN_HASH_KEY: "token-key",
        OTP_HASH_KEY: "otp-key",
        APPROVAL_EVIDENCE_ENCRYPTION_KEY: "evidence-key",
        REVENUECAT_PUBLIC_IOS_KEY: "rc-public",
        REVENUECAT_SECRET_KEY: "rc-secret",
        WEBHOOK_AUTH_SECRET: "webhook",
        MONTHLY_PRODUCT_ID: "monthly",
        ANNUAL_PRODUCT_ID: "annual",
        EMAIL_API_KEY: "email-key",
        EMAIL_WEBHOOK_SECRET: "email-webhook",
        EMAIL_FROM_DOMAIN: "mail.example.com",
        ERROR_REPORTING_DSN: "https://sentry.example.com/1",
        STAFF_AUTH_CONFIG: "staff",
        BACKUP_RETENTION_DAYS: "35",
        FEATURE_NEW_PUBLICATION: "true",
        FEATURE_PURCHASES: "true",
        LIMITS_VERSION: "1",
      }),
    ).toThrow(/placeholder|example\.com|QA68/i);
  });
});
