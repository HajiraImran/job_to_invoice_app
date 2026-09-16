import { describe, expect, it } from "vitest";
import { loadEnv } from "@job-to-invoice/config";
import { createDocumentsDownloadStore, PRESIGN_EXPIRES_SECONDS } from "./documents-store.ts";

describe("documents download store", () => {
  it("mints five-minute GET URLs against the LAN download endpoint", async () => {
    expect(PRESIGN_EXPIRES_SECONDS).toBe(300);
    const env = loadEnv({
      APP_ENV: "development",
      STORAGE_ENDPOINT: "http://127.0.0.1:9000",
      STORAGE_DOWNLOAD_ENDPOINT: "http://192.168.10.24:9000",
      STORAGE_REGION: "us-east-1",
      STORAGE_FORCE_PATH_STYLE: "true",
      STORAGE_WORKER_ACCESS_KEY_ID: "wk_access_dev01",
      STORAGE_WORKER_SECRET_ACCESS_KEY: "wk_secret_dev01_value",
      STORAGE_API_ACCESS_KEY_ID: "api_access_dev01",
      STORAGE_API_SECRET_ACCESS_KEY: "api_secret_dev01_value",
    });
    const storage = env.documentsStorage;
    expect(storage).toBeDefined();
    if (!storage) {
      throw new Error("documents storage config missing");
    }
    const url = await createDocumentsDownloadStore(storage).presignGet(
      "workspaces/11111111-1111-4111-8111-111111111111/documents/22222222-2222-4222-8222-222222222222/revisions/1/original/33333333-3333-4333-8333-333333333333.pdf",
    );
    const parsed = new URL(url);
    expect(parsed.protocol).toBe("http:");
    expect(parsed.hostname).toBe("192.168.10.24");
    expect(parsed.port).toBe("9000");
    expect(parsed.pathname).toContain("job-to-invoice-documents-development");
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]+$/i);
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url).not.toMatch(/public-read|ACL=/i);
    expect(url.includes("?")).toBe(true);
    expect(url).not.toContain("127.0.0.1");
    expect(url).not.toContain("wk_secret_dev01_value");
    expect(url).not.toContain("api_secret_dev01_value");
  });
});
