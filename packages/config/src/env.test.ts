import { describe, expect, it } from "vitest";
import { loadApiEnv, loadEnv, loadWorkerEnv } from "./env.ts";
import { documentsBucket, DEVELOPMENT_DOCUMENTS_BUCKET } from "./storage.ts";

const DEV_API_STORAGE = {
  APP_ENV: "development",
  STORAGE_ENDPOINT: "http://127.0.0.1:9000",
  STORAGE_DOWNLOAD_ENDPOINT: "http://10.0.0.24:9000",
  STORAGE_REGION: "us-east-1",
  STORAGE_FORCE_PATH_STYLE: "true",
  STORAGE_API_ACCESS_KEY_ID: "api_access_dev01",
  STORAGE_API_SECRET_ACCESS_KEY: "api_secret_dev01_value",
} as const;

const DEV_WORKER_STORAGE = {
  APP_ENV: "development",
  STORAGE_ENDPOINT: "http://127.0.0.1:9000",
  STORAGE_DOWNLOAD_ENDPOINT: "http://10.0.0.24:9000",
  STORAGE_REGION: "us-east-1",
  STORAGE_FORCE_PATH_STYLE: "true",
  STORAGE_WORKER_ACCESS_KEY_ID: "wk_access_dev01",
  STORAGE_WORKER_SECRET_ACCESS_KEY: "wk_secret_dev01_value",
} as const;

const PRODUCTION_BASE = {
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
  APPROVAL_TOKEN_HASH_KEY: "token-key-material-ok",
  APPROVAL_DELIVERY_ENCRYPTION_KEY: "delivery-key-material-ok",
  OTP_HASH_KEY: "otp-key-material-ok",
  APPROVAL_EVIDENCE_ENCRYPTION_KEY: "evidence-key-material-ok",
  REVENUECAT_PUBLIC_IOS_KEY: "rc-public",
  REVENUECAT_SECRET_KEY: "rc-secret",
  WEBHOOK_AUTH_SECRET: "webhook-auth-ok",
  MONTHLY_PRODUCT_ID: "monthly",
  ANNUAL_PRODUCT_ID: "annual",
  EMAIL_API_KEY: "email-key-material-ok",
  EMAIL_WEBHOOK_SECRET: "whsec_dGVzdF9lbWFpbF93ZWJob29rX2tleQ",
  EMAIL_FROM_DOMAIN: "mail.jobtoinvoice.test",
  ERROR_REPORTING_DSN: "https://sentry.jobtoinvoice.test/1",
  STAFF_AUTH_CONFIG: "staff",
  BACKUP_RETENTION_DAYS: "35",
  FEATURE_NEW_PUBLICATION: "true",
  FEATURE_PURCHASES: "true",
  LIMITS_VERSION: "1",
} as const;

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

describe("loadApiEnv", () => {
  it("starts with API credentials and no worker credentials", () => {
    const env = loadApiEnv(DEV_API_STORAGE);
    expect(env.documentsStorage?.bucket).toBe(DEVELOPMENT_DOCUMENTS_BUCKET);
    expect(env.documentsStorage?.downloadEndpoint).toBe("http://10.0.0.24:9000");
    expect(env.documentsStorage?.api.accessKeyId).toBe("api_access_dev01");
    expect(env.documentsStorage).not.toHaveProperty("worker");
    expect("STORAGE_WORKER_ACCESS_KEY_ID" in env).toBe(false);
    expect("EMAIL_API_KEY" in env).toBe(false);
    expect("EMAIL_FROM_DOMAIN" in env).toBe(false);
    expect("DATABASE_URL_WORKER" in env).toBe(false);
    expect(JSON.stringify(env)).not.toContain("wk_access_dev01");
    expect(JSON.stringify(env)).not.toContain("wk_secret_dev01_value");
    expect(JSON.stringify(Object.keys(env))).not.toMatch(/EXPO_PUBLIC_/);
  });

  it("omits worker credentials from the returned configuration even when they are present in the source", () => {
    const env = loadApiEnv({
      ...DEV_API_STORAGE,
      STORAGE_WORKER_ACCESS_KEY_ID: "wk_access_dev01",
      STORAGE_WORKER_SECRET_ACCESS_KEY: "wk_secret_dev01_value",
    });
    expect(env.documentsStorage?.api.accessKeyId).toBe("api_access_dev01");
    expect(env.documentsStorage).not.toHaveProperty("worker");
    expect("STORAGE_WORKER_ACCESS_KEY_ID" in env).toBe(false);
    expect("STORAGE_WORKER_SECRET_ACCESS_KEY" in env).toBe(false);
    expect(JSON.stringify(env)).not.toContain("wk_access_dev01");
    expect(JSON.stringify(env)).not.toContain("wk_secret_dev01_value");
  });

  it("fails closed without API credentials", () => {
    expect(() =>
      loadApiEnv({
        APP_ENV: "development",
        STORAGE_ENDPOINT: "http://127.0.0.1:9000",
        STORAGE_REGION: "us-east-1",
        STORAGE_FORCE_PATH_STYLE: "true",
        STORAGE_WORKER_ACCESS_KEY_ID: "wk_access_dev01",
        STORAGE_WORKER_SECRET_ACCESS_KEY: "wk_secret_dev01_value",
      }),
    ).toThrow(/API storage credentials are required/);
  });

  it("loads production R2 aliases with API credentials only", () => {
    const env = loadApiEnv({
      ...PRODUCTION_BASE,
      R2_ACCOUNT_ID: "acct99r2compat01",
      R2_API_ACCESS_KEY_ID: "api_access_prod01",
      R2_API_SECRET_ACCESS_KEY: "api_secret_prod01_value",
    });
    expect(env.documentsStorage?.endpoint).toBe("https://acct99r2compat01.r2.cloudflarestorage.com");
    expect(env.documentsStorage?.region).toBe("auto");
    expect(env.documentsStorage?.forcePathStyle).toBe(false);
    expect(env.documentsStorage?.bucket).toBe("job-to-invoice-documents-production");
    expect(env.documentsStorage).not.toHaveProperty("worker");
    expect("R2_WORKER_ACCESS_KEY_ID" in env).toBe(false);
    expect("EMAIL_API_KEY" in env).toBe(false);
    expect("EMAIL_FROM_DOMAIN" in env).toBe(false);
    expect("EMAIL_WEBHOOK_SECRET" in env).toBe(true);
    expect("APPROVAL_TOKEN_HASH_KEY" in env).toBe(true);
    expect("APPROVAL_DELIVERY_ENCRYPTION_KEY" in env).toBe(true);
  });
});

describe("loadWorkerEnv", () => {
  it("starts with worker credentials and no API credentials", () => {
    const env = loadWorkerEnv(DEV_WORKER_STORAGE);
    expect(env.documentsStorage?.bucket).toBe(DEVELOPMENT_DOCUMENTS_BUCKET);
    expect(env.documentsStorage?.worker.accessKeyId).toBe("wk_access_dev01");
    expect(env.documentsStorage).not.toHaveProperty("api");
    expect("STORAGE_API_ACCESS_KEY_ID" in env).toBe(false);
    expect("EMAIL_WEBHOOK_SECRET" in env).toBe(false);
    expect("APPROVAL_TOKEN_HASH_KEY" in env).toBe(false);
    expect("APPROVAL_EVIDENCE_ENCRYPTION_KEY" in env).toBe(false);
    expect("OTP_HASH_KEY" in env).toBe(false);
    expect("DATABASE_URL_API" in env).toBe(false);
    expect(JSON.stringify(env)).not.toContain("api_access_dev01");
    expect(JSON.stringify(env)).not.toContain("api_secret_dev01_value");
  });

  it("omits API credentials from the returned configuration even when they are present in the source", () => {
    const env = loadWorkerEnv({
      ...DEV_WORKER_STORAGE,
      STORAGE_API_ACCESS_KEY_ID: "api_access_dev01",
      STORAGE_API_SECRET_ACCESS_KEY: "api_secret_dev01_value",
    });
    expect(env.documentsStorage?.worker.accessKeyId).toBe("wk_access_dev01");
    expect(env.documentsStorage).not.toHaveProperty("api");
    expect("STORAGE_API_ACCESS_KEY_ID" in env).toBe(false);
    expect("STORAGE_API_SECRET_ACCESS_KEY" in env).toBe(false);
    expect(JSON.stringify(env)).not.toContain("api_access_dev01");
    expect(JSON.stringify(env)).not.toContain("api_secret_dev01_value");
  });

  it("fails closed without worker credentials", () => {
    expect(() =>
      loadWorkerEnv({
        APP_ENV: "development",
        STORAGE_ENDPOINT: "http://127.0.0.1:9000",
        STORAGE_REGION: "us-east-1",
        STORAGE_FORCE_PATH_STYLE: "true",
        STORAGE_API_ACCESS_KEY_ID: "api_access_dev01",
        STORAGE_API_SECRET_ACCESS_KEY: "api_secret_dev01_value",
      }),
    ).toThrow(/worker storage credentials are required/);
  });

  it("loads production R2 aliases with worker credentials only", () => {
    const env = loadWorkerEnv({
      ...PRODUCTION_BASE,
      R2_ACCOUNT_ID: "acct99r2compat01",
      R2_WORKER_ACCESS_KEY_ID: "wk_access_prod01",
      R2_WORKER_SECRET_ACCESS_KEY: "wk_secret_prod01_value",
    });
    expect(env.documentsStorage?.endpoint).toBe("https://acct99r2compat01.r2.cloudflarestorage.com");
    expect(env.documentsStorage?.region).toBe("auto");
    expect(env.documentsStorage?.forcePathStyle).toBe(false);
    expect(env.documentsStorage?.bucket).toBe("job-to-invoice-documents-production");
    expect(env.documentsStorage).not.toHaveProperty("api");
    expect("R2_API_ACCESS_KEY_ID" in env).toBe(false);
    expect("EMAIL_WEBHOOK_SECRET" in env).toBe(false);
    expect("APPROVAL_TOKEN_HASH_KEY" in env).toBe(false);
    expect("APPROVAL_EVIDENCE_ENCRYPTION_KEY" in env).toBe(false);
    expect("EMAIL_API_KEY" in env).toBe(true);
    expect("APPROVAL_DELIVERY_ENCRYPTION_KEY" in env).toBe(true);
  });

  it("rejects minioadmin placeholders and production private endpoints", () => {
    expect(() =>
      loadWorkerEnv({
        APP_ENV: "development",
        STORAGE_ENDPOINT: "http://127.0.0.1:9000",
        STORAGE_REGION: "us-east-1",
        STORAGE_FORCE_PATH_STYLE: "true",
        STORAGE_WORKER_ACCESS_KEY_ID: "minioadmin",
        STORAGE_WORKER_SECRET_ACCESS_KEY: "wk_secret_dev01_value",
      }),
    ).toThrow(/placeholder|QA68/i);
    expect(() =>
      loadApiEnv({
        ...PRODUCTION_BASE,
        STORAGE_ENDPOINT: "https://192.168.1.9",
        STORAGE_REGION: "auto",
        STORAGE_FORCE_PATH_STYLE: "false",
        STORAGE_API_ACCESS_KEY_ID: "api_access_prod01",
        STORAGE_API_SECRET_ACCESS_KEY: "api_secret_prod01_value",
      }),
    ).toThrow(/QA68|local or private/i);
  });
});
