import { describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";

describe("foundation API", () => {
  it("serves /v1/health without commercial routes", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.product).toBe(false);
    await app.close();
  });
});
