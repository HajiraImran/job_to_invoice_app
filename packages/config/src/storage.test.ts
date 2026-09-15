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
  resolveDocumentsStorage,
  workerClientOptions,
} from "./storage.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const DEV_STORAGE = {
  APP_ENV: "development",
  STORAGE_ENDPOINT: "http://127.0.0.1:9000",
  STORAGE_DOWNLOAD_ENDPOINT: "http://192.168.10.24:9000",
  STORAGE_REGION: "us-east-1",
  STORAGE_DOCUMENTS_BUCKET: DEVELOPMENT_DOCUMENTS_BUCKET,
  STORAGE_FORCE_PATH_STYLE: "true",
  STORAGE_WORKER_ACCESS_KEY_ID: "wk_access_dev01",
  STORAGE_WORKER_SECRET_ACCESS_KEY: "wk_secret_dev01_value",
  STORAGE_API_ACCESS_KEY_ID: "api_access_dev01",
  STORAGE_API_SECRET_ACCESS_KEY: "api_secret_dev01_value",
} as const;

function requireStorage(source: typeof DEV_STORAGE) {
  const config = resolveDocumentsStorage(source);
  expect(config).toBeDefined();
  if (!config) {
    throw new Error("documents storage config missing");
  }
  return config;
}

describe("documents storage", () => {
  it("accepts development MinIO on localhost with a LAN download endpoint", () => {
    const config = requireStorage(DEV_STORAGE);
    expect(config).toMatchObject({
      endpoint: "http://127.0.0.1:9000",
      downloadEndpoint: "http://192.168.10.24:9000",
      region: "us-east-1",
      bucket: DEVELOPMENT_DOCUMENTS_BUCKET,
      forcePathStyle: true,
    });
    expect(workerClientOptions(config).endpoint).toBe("http://127.0.0.1:9000");
    expect(apiClientOptions(config).endpoint).toBe("http://192.168.10.24:9000");
    expect(apiClientOptions(config).forcePathStyle).toBe(true);
  });

  it("signs API downloads against the configured LAN endpoint, not localhost", () => {
    const config = requireStorage(DEV_STORAGE);
    expect(apiClientOptions(config).endpoint).not.toContain("127.0.0.1");
    expect(apiClientOptions(config).endpoint).not.toContain("localhost");
    expect(workerClientOptions(config).endpoint).toContain("127.0.0.1");
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

  it("fails closed when credentials are missing", () => {
    expect(resolveDocumentsStorage({ APP_ENV: "development" })).toBeUndefined();
    expect(() =>
      resolveDocumentsStorage({
        APP_ENV: "development",
        STORAGE_ENDPOINT: "http://127.0.0.1:9000",
      }),
    ).toThrow(/required/);
    expect(() =>
      resolveDocumentsStorage({
        APP_ENV: "production",
        STORAGE_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
        STORAGE_REGION: "auto",
        STORAGE_FORCE_PATH_STYLE: "false",
        STORAGE_WORKER_ACCESS_KEY_ID: "wk_access_prod01",
        STORAGE_WORKER_SECRET_ACCESS_KEY: "wk_secret_prod01_value",
      }),
    ).toThrow(/API storage credentials are required/);
  });

  it("requires worker and API credentials to differ", () => {
    expect(() =>
      resolveDocumentsStorage({
        ...DEV_STORAGE,
        STORAGE_API_ACCESS_KEY_ID: DEV_STORAGE.STORAGE_WORKER_ACCESS_KEY_ID,
      }),
    ).toThrow(/must be different/);
    expect(() =>
      resolveDocumentsStorage({
        ...DEV_STORAGE,
        STORAGE_API_SECRET_ACCESS_KEY: DEV_STORAGE.STORAGE_WORKER_SECRET_ACCESS_KEY,
      }),
    ).toThrow(/must be different/);
  });

  it("does not leak secrets in configuration errors", () => {
    const secret = "wk_secret_must_stay_private_91";
    let message = "";
    try {
      resolveDocumentsStorage({
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
    expect(message).toMatch(/required/);
    expect(message).not.toContain(secret);
  });

  it("rejects EXPO_PUBLIC storage secrets and STORAGE_SERVICE_KEY", () => {
    expect(() =>
      resolveDocumentsStorage({
        ...DEV_STORAGE,
        EXPO_PUBLIC_STORAGE_API_SECRET_ACCESS_KEY: "api_secret_dev01_value",
      }),
    ).toThrow(/EXPO_PUBLIC_/);
    expect(() =>
      resolveDocumentsStorage({
        ...DEV_STORAGE,
        STORAGE_SERVICE_KEY: "must-not-be-used",
      }),
    ).toThrow(/STORAGE_SERVICE_KEY/);
  });

  it("keeps worker write credentials out of the API client", () => {
    const config = requireStorage(DEV_STORAGE);
    expect(apiClientOptions(config).credentials.accessKeyId).toBe("api_access_dev01");
    expect(apiClientOptions(config).credentials.secretAccessKey).toBe("api_secret_dev01_value");
    expect(workerClientOptions(config).credentials.accessKeyId).toBe("wk_access_dev01");
    expect(workerClientOptions(config).credentials.accessKeyId).not.toBe(
      apiClientOptions(config).credentials.accessKeyId,
    );
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
