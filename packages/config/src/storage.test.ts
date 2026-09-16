import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  apiClientOptions,
  assertStorageEndpoint,
  DEVELOPMENT_DOCUMENTS_BUCKET,
  documentsBucket,
  PRODUCTION_DOCUMENTS_BUCKET,
  redactStorageConfig,
  resolveApiDocumentsStorage,
  resolveWorkerDocumentsStorage,
  workerClientOptions,
} from "./storage.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const SHARED_DEV_STORAGE = {
  APP_ENV: "development",
  STORAGE_ENDPOINT: "http://127.0.0.1:9000",
  STORAGE_DOWNLOAD_ENDPOINT: "http://192.168.10.24:9000",
  STORAGE_REGION: "us-east-1",
  STORAGE_DOCUMENTS_BUCKET: DEVELOPMENT_DOCUMENTS_BUCKET,
  STORAGE_FORCE_PATH_STYLE: "true",
} as const;

const API_DEV_STORAGE = {
  ...SHARED_DEV_STORAGE,
  STORAGE_API_ACCESS_KEY_ID: "api_access_dev01",
  STORAGE_API_SECRET_ACCESS_KEY: "api_secret_dev01_value",
} as const;

const WORKER_DEV_STORAGE = {
  ...SHARED_DEV_STORAGE,
  STORAGE_WORKER_ACCESS_KEY_ID: "wk_access_dev01",
  STORAGE_WORKER_SECRET_ACCESS_KEY: "wk_secret_dev01_value",
} as const;

const MIXED_DEV_STORAGE = {
  ...API_DEV_STORAGE,
  ...WORKER_DEV_STORAGE,
} as const;

function requireApiStorage(source: NodeJS.Dict<string> & { APP_ENV: string }) {
  const config = resolveApiDocumentsStorage(source);
  expect(config).toBeDefined();
  if (!config) {
    throw new Error("API documents storage config missing");
  }
  return config;
}

function requireWorkerStorage(source: NodeJS.Dict<string> & { APP_ENV: string }) {
  const config = resolveWorkerDocumentsStorage(source);
  expect(config).toBeDefined();
  if (!config) {
    throw new Error("worker documents storage config missing");
  }
  return config;
}

describe("documents storage", () => {
  it("accepts development MinIO on localhost with a LAN download endpoint", () => {
    const apiConfig = requireApiStorage(API_DEV_STORAGE);
    const workerConfig = requireWorkerStorage(WORKER_DEV_STORAGE);
    expect(apiConfig).toMatchObject({
      endpoint: "http://127.0.0.1:9000",
      downloadEndpoint: "http://192.168.10.24:9000",
      region: "us-east-1",
      bucket: DEVELOPMENT_DOCUMENTS_BUCKET,
      forcePathStyle: true,
    });
    expect(workerConfig).toMatchObject({
      endpoint: "http://127.0.0.1:9000",
      region: "us-east-1",
      bucket: DEVELOPMENT_DOCUMENTS_BUCKET,
      forcePathStyle: true,
    });
    expect(workerClientOptions(workerConfig).endpoint).toBe("http://127.0.0.1:9000");
    expect(apiClientOptions(apiConfig).endpoint).toBe("http://192.168.10.24:9000");
    expect(apiClientOptions(apiConfig).forcePathStyle).toBe(true);
  });

  it("signs API downloads against the configured LAN endpoint, not localhost", () => {
    const apiConfig = requireApiStorage(API_DEV_STORAGE);
    const workerConfig = requireWorkerStorage(WORKER_DEV_STORAGE);
    expect(apiClientOptions(apiConfig).endpoint).not.toContain("127.0.0.1");
    expect(apiClientOptions(apiConfig).endpoint).not.toContain("localhost");
    expect(workerClientOptions(workerConfig).endpoint).toContain("127.0.0.1");
  });

  it("rejects production HTTP and private hosts", () => {
    expect(() =>
      assertStorageEndpoint("http://documents.jobtoinvoice.test", "production", "STORAGE_ENDPOINT"),
    ).toThrow(/must be https/);
    expect(() =>
      assertStorageEndpoint("https://127.0.0.1:9000", "production", "STORAGE_ENDPOINT"),
    ).toThrow(/local or private/);
    expect(() =>
      assertStorageEndpoint("https://10.0.0.8:9000", "production", "STORAGE_ENDPOINT"),
    ).toThrow(/local or private/);
    expect(() =>
      assertStorageEndpoint("https://192.168.1.9:9000", "staging", "STORAGE_DOWNLOAD_ENDPOINT"),
    ).toThrow(/local or private/);
    expect(() =>
      assertStorageEndpoint("https://172.16.4.4:9000", "production", "STORAGE_ENDPOINT"),
    ).toThrow(/local or private/);
  });

  it("rejects development HTTP on a public host", () => {
    expect(() =>
      assertStorageEndpoint("http://documents.jobtoinvoice.test", "development", "STORAGE_ENDPOINT"),
    ).toThrow(/localhost or RFC1918/);
  });

  it("configures API storage with API credentials and no worker credentials", () => {
    const config = requireApiStorage(API_DEV_STORAGE);
    expect(config.api.accessKeyId).toBe("api_access_dev01");
    expect(config).not.toHaveProperty("worker");
    expect(JSON.stringify(config)).not.toContain("wk_access_dev01");
    expect(JSON.stringify(config)).not.toContain("wk_secret_dev01_value");
    expect(JSON.stringify(config)).not.toMatch(/STORAGE_WORKER_|R2_WORKER_/);
  });

  it("configures worker storage with worker credentials and no API credentials", () => {
    const config = requireWorkerStorage(WORKER_DEV_STORAGE);
    expect(config.worker.accessKeyId).toBe("wk_access_dev01");
    expect(config).not.toHaveProperty("api");
    expect(JSON.stringify(config)).not.toContain("api_access_dev01");
    expect(JSON.stringify(config)).not.toContain("api_secret_dev01_value");
    expect(JSON.stringify(config)).not.toMatch(/STORAGE_API_|R2_API_/);
  });

  it("does not retain the other service's credentials even when they are present in the source", () => {
    const apiConfig = requireApiStorage(MIXED_DEV_STORAGE);
    const workerConfig = requireWorkerStorage(MIXED_DEV_STORAGE);
    expect(apiConfig).not.toHaveProperty("worker");
    expect(workerConfig).not.toHaveProperty("api");
    expect(JSON.stringify(apiConfig)).not.toContain("wk_access_dev01");
    expect(JSON.stringify(apiConfig)).not.toContain("wk_secret_dev01_value");
    expect(JSON.stringify(workerConfig)).not.toContain("api_access_dev01");
    expect(JSON.stringify(workerConfig)).not.toContain("api_secret_dev01_value");
  });

  it("fails closed when the current service's credentials are missing", () => {
    expect(resolveApiDocumentsStorage({ APP_ENV: "development" })).toBeUndefined();
    expect(resolveWorkerDocumentsStorage({ APP_ENV: "development" })).toBeUndefined();
    expect(() =>
      resolveApiDocumentsStorage({
        APP_ENV: "development",
        STORAGE_ENDPOINT: "http://127.0.0.1:9000",
        STORAGE_REGION: "us-east-1",
        STORAGE_FORCE_PATH_STYLE: "true",
      }),
    ).toThrow(/API storage credentials are required/);
    expect(() =>
      resolveWorkerDocumentsStorage({
        APP_ENV: "development",
        STORAGE_ENDPOINT: "http://127.0.0.1:9000",
        STORAGE_REGION: "us-east-1",
        STORAGE_FORCE_PATH_STYLE: "true",
      }),
    ).toThrow(/worker storage credentials are required/);
    expect(() =>
      resolveApiDocumentsStorage({
        APP_ENV: "production",
        STORAGE_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
        STORAGE_REGION: "auto",
        STORAGE_FORCE_PATH_STYLE: "false",
        STORAGE_WORKER_ACCESS_KEY_ID: "wk_access_prod01",
        STORAGE_WORKER_SECRET_ACCESS_KEY: "wk_secret_prod01_value",
      }),
    ).toThrow(/API storage credentials are required/);
    expect(() =>
      resolveWorkerDocumentsStorage({
        APP_ENV: "production",
        STORAGE_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
        STORAGE_REGION: "auto",
        STORAGE_FORCE_PATH_STYLE: "false",
        STORAGE_API_ACCESS_KEY_ID: "api_access_prod01",
        STORAGE_API_SECRET_ACCESS_KEY: "api_secret_prod01_value",
      }),
    ).toThrow(/worker storage credentials are required/);
  });

  it("does not leak secrets in configuration errors", () => {
    const secret = "wk_secret_must_stay_private_91";
    let message = "";
    try {
      resolveApiDocumentsStorage({
        APP_ENV: "development",
        STORAGE_ENDPOINT: "http://127.0.0.1:9000",
        STORAGE_REGION: "us-east-1",
        STORAGE_FORCE_PATH_STYLE: "true",
        STORAGE_WORKER_ACCESS_KEY_ID: "wk_access_dev01",
        STORAGE_WORKER_SECRET_ACCESS_KEY: secret,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/API storage credentials are required/);
    expect(message).not.toContain(secret);
  });

  it("rejects EXPO_PUBLIC storage secrets and STORAGE_SERVICE_KEY", () => {
    expect(() =>
      resolveApiDocumentsStorage({
        ...API_DEV_STORAGE,
        EXPO_PUBLIC_STORAGE_API_SECRET_ACCESS_KEY: "api_secret_dev01_value",
      }),
    ).toThrow(/EXPO_PUBLIC_/);
    expect(() =>
      resolveWorkerDocumentsStorage({
        ...WORKER_DEV_STORAGE,
        STORAGE_SERVICE_KEY: "must-not-be-used",
      }),
    ).toThrow(/STORAGE_SERVICE_KEY/);
  });

  it("keeps worker write credentials out of the API client", () => {
    const apiConfig = requireApiStorage(API_DEV_STORAGE);
    const workerConfig = requireWorkerStorage(WORKER_DEV_STORAGE);
    expect(apiClientOptions(apiConfig).credentials.accessKeyId).toBe("api_access_dev01");
    expect(apiClientOptions(apiConfig).credentials.secretAccessKey).toBe("api_secret_dev01_value");
    expect(workerClientOptions(workerConfig).credentials.accessKeyId).toBe("wk_access_dev01");
    expect(workerClientOptions(workerConfig).credentials.accessKeyId).not.toBe(
      apiClientOptions(apiConfig).credentials.accessKeyId,
    );
  });

  it("applies Cloudflare R2 defaults from R2_ACCOUNT_ID without path-style", () => {
    const apiConfig = resolveApiDocumentsStorage({
      APP_ENV: "production",
      R2_ACCOUNT_ID: "acct99r2compat01",
      R2_API_ACCESS_KEY_ID: "api_access_prod01",
      R2_API_SECRET_ACCESS_KEY: "api_secret_prod01_value",
    });
    const workerConfig = resolveWorkerDocumentsStorage({
      APP_ENV: "production",
      R2_ACCOUNT_ID: "acct99r2compat01",
      R2_WORKER_ACCESS_KEY_ID: "wk_access_prod01",
      R2_WORKER_SECRET_ACCESS_KEY: "wk_secret_prod01_value",
    });
    expect(apiConfig).toBeDefined();
    expect(workerConfig).toBeDefined();
    if (!apiConfig || !workerConfig) {
      throw new Error("documents storage config missing");
    }
    expect(apiConfig.endpoint).toBe("https://acct99r2compat01.r2.cloudflarestorage.com");
    expect(workerConfig.endpoint).toBe(apiConfig.endpoint);
    expect(apiConfig.region).toBe("auto");
    expect(workerConfig.region).toBe("auto");
    expect(apiConfig.forcePathStyle).toBe(false);
    expect(workerConfig.forcePathStyle).toBe(false);
    expect(apiConfig.bucket).toBe(PRODUCTION_DOCUMENTS_BUCKET);
    expect(workerConfig.bucket).toBe(PRODUCTION_DOCUMENTS_BUCKET);
    expect(workerClientOptions(workerConfig).endpoint).toBe(workerConfig.endpoint);
    expect(apiClientOptions(apiConfig).endpoint).toBe(apiConfig.endpoint);
    expect(apiConfig).not.toHaveProperty("worker");
    expect(workerConfig).not.toHaveProperty("api");
  });

  it("uses MinIO path-style addressing on the local S3 endpoint", () => {
    const apiConfig = requireApiStorage(API_DEV_STORAGE);
    const workerConfig = requireWorkerStorage(WORKER_DEV_STORAGE);
    expect(apiConfig.forcePathStyle).toBe(true);
    expect(workerConfig.forcePathStyle).toBe(true);
    expect(apiConfig.endpoint).toBe("http://127.0.0.1:9000");
    expect(workerClientOptions(workerConfig).forcePathStyle).toBe(true);
    expect(apiClientOptions(apiConfig).forcePathStyle).toBe(true);
  });

  it("redacts all storage configuration from logged objects", () => {
    const apiConfig = requireApiStorage(API_DEV_STORAGE);
    const workerConfig = requireWorkerStorage(WORKER_DEV_STORAGE);
    const redacted = redactStorageConfig({
      APP_ENV: "development",
      STORAGE_ENDPOINT: apiConfig.endpoint,
      STORAGE_WORKER_SECRET_ACCESS_KEY: "wk_secret_dev01_value",
      documentsStorage: { api: apiConfig, worker: workerConfig },
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("wk_secret_dev01_value");
    expect(serialized).not.toContain("api_secret_dev01_value");
    expect(serialized).not.toContain("127.0.0.1:9000");
    expect(serialized).toContain("[REDACTED]");
  });

  it("defaults private bucket names", () => {
    expect(documentsBucket("development")).toBe(DEVELOPMENT_DOCUMENTS_BUCKET);
    expect(documentsBucket("production")).toBe(PRODUCTION_DOCUMENTS_BUCKET);
    expect(() => documentsBucket("staging")).toThrow(/STORAGE_DOCUMENTS_BUCKET/);
  });

  it("does not ship a public MinIO bucket policy or default credentials", () => {
    const compose = readFileSync(join(repoRoot, "docker-compose.minio.yml"), "utf8");
    const init = readFileSync(join(repoRoot, "deploy/minio/init.sh"), "utf8");
    const workerPolicy = readFileSync(join(repoRoot, "deploy/minio/worker-policy.json"), "utf8");
    const apiPolicy = readFileSync(join(repoRoot, "deploy/minio/api-policy.json"), "utf8");
    expect(compose).toMatch(/healthcheck:/);
    expect(compose).toMatch(/MINIO_ROOT_USER: \$\{MINIO_ROOT_USER:/);
    expect(compose).toMatch(/MINIO_ROOT_PASSWORD: \$\{MINIO_ROOT_PASSWORD:/);
    expect(compose).toMatch(/127\.0\.0\.1:9001:9001/);
    expect(compose).toMatch(/var\/minio:\/data/);
    expect(compose).not.toMatch(/minioadmin/i);
    expect(compose).not.toMatch(/MINIO_ROOT_PASSWORD:\s*['"]?\w/);
    expect(init).toMatch(/mc anonymous set none/);
    expect(init).toMatch(/job-to-invoice-documents-development/);
    expect(init).not.toMatch(/anonymous set (public|download)/);
    expect(init).not.toMatch(/minioadmin/i);
    expect(init).not.toMatch(/set -x/);
    expect(workerPolicy).toMatch(/s3:PutObject/);
    expect(workerPolicy).not.toMatch(/s3:ListBucket/);
    expect(apiPolicy).toMatch(/s3:GetObject/);
    expect(apiPolicy).not.toMatch(/s3:PutObject/);
    expect(apiPolicy).not.toMatch(/s3:ListBucket/);
  });
});
