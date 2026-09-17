import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { accessStateKind, canApprove, codeErrorKind, documentKind, portalCopy, readFragmentToken } from "./review";

const root = dirname(fileURLToPath(import.meta.url));

describe("portal fragment and states", () => {
  it("reads the fragment token and rejects query-shaped values", () => {
    expect(readFragmentToken("#abcdefghijklmnopqrstuvwxyzABCDEFG0123456789_-")).toBe(
      "abcdefghijklmnopqrstuvwxyzABCDEFG0123456789_-",
    );
    expect(readFragmentToken("?token=abc")).toBeUndefined();
    expect(readFragmentToken("#short")).toBeUndefined();
  });

  it("maps access and OTP errors to the required S25 states", () => {
    expect(accessStateKind("pending")).toBe("awaiting_verification");
    expect(accessStateKind("expired")).toBe("expired_quote");
    expect(accessStateKind("superseded")).toBe("superseded");
    expect(accessStateKind("unavailable")).toBe("invalid_link");
    expect(codeErrorKind(undefined, 0)).toBe("network_failure");
    expect(codeErrorKind("RATE_LIMITED", 429)).toBe("too_many_attempts");
    expect(codeErrorKind("VALIDATION_FAILED", 422)).toBe("incorrect_code");
  });

  it("disables approve until the PDF is ready and consent is ticked", () => {
    expect(documentKind({ accessState: "pending", pdfState: "preparing" })).toBe("pdf_loading");
    expect(documentKind({ accessState: "pending", pdfState: "ready" })).toBe("quote_ready");
    expect(canApprove("quote_ready", false, true)).toBe(false);
    expect(canApprove("quote_ready", true, true)).toBe(true);
    expect(canApprove("pdf_loading", true, false)).toBe(false);
  });

  it("uses NTF05 copy and a single-column 720px layout with labelled controls", () => {
    expect(portalCopy.expiredQuote).toBe("This request has expired. Ask the business for a new version.");
    expect(portalCopy.supersededQuote).toBe("A newer version is available. This version cannot be approved.");
    const layout = readFileSync(join(root, "../app/layout.tsx"), "utf8");
    expect(layout).toContain("max-width: 720px");
    expect(layout).toContain("padding: 24px 16px");
    expect(layout).toContain("min-height: 44px");
    const access = readFileSync(join(root, "../app/review/page.tsx"), "utf8");
    expect(access).toContain('role="status"');
    expect(access).toContain('role="alert"');
    expect(access).toContain("history.replaceState");
    expect(access).not.toContain("?token=");
    const document = readFileSync(join(root, "../app/review/document/page.tsx"), "utf8");
    expect(document).toContain('type="checkbox"');
    expect(document).toContain("consent");
    const receipt = readFileSync(join(root, "../app/review/receipt/page.tsx"), "utf8");
    expect(receipt).toContain("payment_claimed");
  });
});
