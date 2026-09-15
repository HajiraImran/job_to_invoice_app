import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.ts";
import { documentsBucket, DEVELOPMENT_DOCUMENTS_BUCKET } from "./storage.ts";

describe("loadEnv", () => {
  it("accepts development with local defaults", () => {
    const env = loadEnv({ APP_ENV: "development" });
    expect(env.APP_ENV).toBe("development");
    expect(env.API_BASE_URL).toContain("localhost");
  });

  it("defaults private document buckets and requires staging to set the name", () => {
    expect(documentsBucket("development")).toBe(DEVELOPMENT_DOCUMENTS_BUCKET);
    expect(documentsBucket("production")).toBe("job-to-invoice-documents-production");
    expect(documentsBucket("staging", "job-to-invoice-documents-staging")).toBe(
      "job-to-invoice-documents-staging",
    );
    expect(() => documentsBucket("staging")).toThrow(/STORAGE_DOCUMENTS_BUCKET/);
  });

  it("loads development MinIO storage without exposing EXPO_PUBLIC credentials", () => {
    const env = loadEnv({
      APP_ENV: "development",
      STORAGE_ENDPOINT: "http://127.0.0.1:9000",
      STORAGE_DOWNLOAD_ENDPOINT: "http://10.0.0.24:9000",
      STORAGE_REGION: "us-east-1",
      STORAGE_FORCE_PATH_STYLE: "true",
      STORAGE_WORKER_ACCESS_KEY_ID: "wk_access_dev01",
      STORAGE_WORKER_SECRET_ACCESS_KEY: "wk_secret_dev01_value",
      STORAGE_API_ACCESS_KEY_ID: "api_access_dev01",
      STORAGE_API_SECRET_ACCESS_KEY: "api_secret_dev01_value",
    });
    expect(env.documentsStorage?.bucket).toBe(DEVELOPMENT_DOCUMENTS_BUCKET);
    expect(env.documentsStorage?.downloadEndpoint).toBe("http://10.0.0.24:9000");
    expect(JSON.stringify(Object.keys(env))).not.toMatch(/EXPO_PUBLIC_/);
  });

  it("rejects minioadmin placeholders and production private endpoints", () => {
    expect(() =>
      loadEnv({
        APP_ENV: "development",
        STORAGE_ENDPOINT: "http://127.0.0.1:9000",
        STORAGE_REGION: "us-east-1",
        STORAGE_FORCE_PATH_STYLE: "true",
        STORAGE_WORKER_ACCESS_KEY_ID: "minioadmin",
        STORAGE_WORKER_SECRET_ACCESS_KEY: "wk_secret_dev01_value",
        STORAGE_API_ACCESS_KEY_ID: "api_access_dev01",
        STORAGE_API_SECRET_ACCESS_KEY: "api_secret_dev01_value",
      }),
    ).toThrow(/placeholder|QA68/i);
    expect(() =>
      loadEnv({
        APP_ENV: "production",
        PUBLIC_APP_NAME: "Job to Invoice",
        SUPPORT_URL: "https://support.jobtoinvoice.test",
        OWNER_APP_BUNDLE_ID: "com.jobtoinvoice.app",
        API_BASE_URL: "https://api.jobtoinvoice.test",
        PORTAL_ORIGIN: "https://portal.jobtoinvoice.test",
        AUTH_PROJECT_URL: "https://auth.jobtoinvoice.test",
        AUTH_PUBLISHABLE_KEY: "publishable-key",
        AUTH_ISSUER: "https://auth.jobtoinvoice.test/auth/v1",
        AUTH_AUDIENCE: "authenticated",
        DATABASE_URL_API: "postgres://api:stored@db:5432/app",
        DATABASE_URL_WORKER: "postgres://worker:stored@db:5432/app",
        DATABASE_URL_PURGE: "postgres://purge:stored@db:5432/app",
        DATABASE_URL_MIGRATIONS: "postgres://migrator:stored@db:5432/app",
        STORAGE_ENDPOINT: "https://192.168.1.9",
        STORAGE_REGION: "auto",
        STORAGE_FORCE_PATH_STYLE: "false",
        STORAGE_WORKER_ACCESS_KEY_ID: "wk_access_prod01",
        STORAGE_WORKER_SECRET_ACCESS_KEY: "wk_secret_prod01_value",
        STORAGE_API_ACCESS_KEY_ID: "api_access_prod01",
        STORAGE_API_SECRET_ACCESS_KEY: "api_secret_prod01_value",
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
        EMAIL_FROM_DOMAIN: "mail.jobtoinvoice.test",
        ERROR_REPORTING_DSN: "https://sentry.jobtoinvoice.test/1",
        STAFF_AUTH_CONFIG: "staff",
        BACKUP_RETENTION_DAYS: "35",
        FEATURE_NEW_PUBLICATION: "true",
        FEATURE_PURCHASES: "true",
        LIMITS_VERSION: "1",
      }),
    ).toThrow(/QA68|local or private/i);
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
