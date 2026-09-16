import { describe, expect, it } from "vitest";
import { loadEnv, workerClientOptions } from "@job-to-invoice/config";
import { privatePutObjectInput } from "./documents-store.ts";
import { workerStatus } from "./run.ts";

const DEV_STORAGE = {
  APP_ENV: "development",
  STORAGE_ENDPOINT: "http://127.0.0.1:9000",
  STORAGE_DOWNLOAD_ENDPOINT: "http://192.168.10.24:9000",
  STORAGE_REGION: "us-east-1",
  STORAGE_FORCE_PATH_STYLE: "true",
  STORAGE_WORKER_ACCESS_KEY_ID: "wk_access_dev01",
  STORAGE_WORKER_SECRET_ACCESS_KEY: "wk_secret_dev01_value",
  STORAGE_API_ACCESS_KEY_ID: "api_access_dev01",
  STORAGE_API_SECRET_ACCESS_KEY: "api_secret_dev01_value",
} as const;

describe("documents object store", () => {
  it("uploads privately to the internal MinIO endpoint without a public ACL", () => {
    const env = loadEnv(DEV_STORAGE);
    const storage = env.documentsStorage;
    expect(storage).toBeDefined();
    if (!storage) {
      throw new Error("documents storage config missing");
    }
    const key =
      "workspaces/11111111-1111-4111-8111-111111111111/documents/22222222-2222-4222-8222-222222222222/revisions/1/original/33333333-3333-4333-8333-333333333333.pdf";
    const input = privatePutObjectInput({
      bucket: storage.bucket,
      key,
      body: Buffer.from("%PDF-1.4"),
      contentType: "application/pdf",
    });
    expect(input.Bucket).toBe("job-to-invoice-documents-development");
    expect(input.Key).toBe(key);
    expect(input.ContentType).toBe("application/pdf");
    expect(input).not.toHaveProperty("ACL");
    expect(input).not.toHaveProperty("GrantRead");
    expect(workerClientOptions(storage).endpoint).toBe("http://127.0.0.1:9000");
    expect(workerClientOptions(storage).forcePathStyle).toBe(true);
    expect(workerClientOptions(storage).credentials.accessKeyId).toBe("wk_access_dev01");
    expect(workerStatus(env)).not.toContain("wk_secret_dev01_value");
    expect(workerStatus(env)).not.toContain("api_secret_dev01_value");
    expect(workerStatus(env)).not.toContain("127.0.0.1:9000");
  });
});
