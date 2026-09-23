import { describe, expect, it } from "vitest";
import {
  SUPPORT_CATEGORIES,
  parseSupportCase,
  publicSupportUrl,
} from "./support.ts";

describe("owner support case body", () => {
  it("accepts an allowlisted category, bounded message, and optional content grant", () => {
    expect(SUPPORT_CATEGORIES).toEqual(["account", "billing", "documents", "access", "other"]);
    const parsed = parseSupportCase({
      category: "billing",
      message: "I cannot start a trial after three published jobs.",
      grant_content_access: true,
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        category: "billing",
        message: "I cannot start a trial after three published jobs.",
        grant_content_access: true,
      },
    });
  });

  it("rejects unknown fields, invented categories, and short or control messages", () => {
    expect(parseSupportCase({ category: "billing", message: "Too short", extra: true }).ok).toBe(false);
    expect(parseSupportCase({ category: "staff", message: "Please look at my invoice totals." }).ok).toBe(false);
    expect(parseSupportCase({ category: "account", message: "short" }).ok).toBe(false);
    expect(
      parseSupportCase({ category: "account", message: "Please help me with this\u0007 account." }).ok,
    ).toBe(false);
    expect(parseSupportCase({ category: "account", message: "A reasonable support message.", grant_content_access: "yes" }).ok).toBe(
      false,
    );
  });

  it("defaults the content grant to false and trims the message", () => {
    const parsed = parseSupportCase({
      category: "other",
      message: "  Please explain why export is unavailable.  ",
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        category: "other",
        message: "Please explain why export is unavailable.",
        grant_content_access: false,
      },
    });
  });
});

describe("public support URL", () => {
  it("returns configured https destinations and rejects empty or invented values", () => {
    expect(publicSupportUrl("https://support.example.test/help")).toBe("https://support.example.test/help");
    expect(publicSupportUrl("http://localhost:3000/help")).toBe("http://localhost:3000/help");
    expect(publicSupportUrl("")).toBeNull();
    expect(publicSupportUrl("javascript:alert(1)")).toBeNull();
    expect(publicSupportUrl("https://placeholder.invalid")).toBe("https://placeholder.invalid");
  });
});
