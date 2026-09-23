import { describe, expect, it } from "vitest";
import {
  csvFormulaSafeCell,
  exportJobCountBucket,
  exportSizeBucket,
  parseExportRequest,
  toCsvRow,
} from "./export.ts";

describe("owner export parsers", () => {
  it("accepts empty or newer-only bodies", () => {
    expect(parseExportRequest(undefined)).toEqual({ ok: true, value: { newer: false } });
    expect(parseExportRequest({})).toEqual({ ok: true, value: { newer: false } });
    expect(parseExportRequest({ newer: true })).toEqual({ ok: true, value: { newer: true } });
    expect(parseExportRequest({ newer: "yes" }).ok).toBe(false);
    expect(parseExportRequest({ newer: false, extra: 1 }).ok).toBe(false);
  });

  it("prefixes formula-like CSV cells (QA55)", () => {
    expect(csvFormulaSafeCell("=cmd")).toBe("'=cmd");
    expect(csvFormulaSafeCell("+1+1")).toBe("'+1+1");
    expect(csvFormulaSafeCell("-1")).toBe("'-1");
    expect(csvFormulaSafeCell("@sum")).toBe("'@sum");
    expect(toCsvRow(["Riley", 1250, "USD"])).toBe("Riley,1250,USD");
    expect(toCsvRow(["=1+1", 'say "hi"'])).toBe(`'=1+1,"say ""hi"""`);
  });

  it("buckets size and job counts without amounts", () => {
    expect(exportSizeBucket(12)).toBe("0_1mb");
    expect(exportSizeBucket(2_000_000)).toBe("1_10mb");
    expect(exportJobCountBucket(0)).toBe("0");
    expect(exportJobCountBucket(12)).toBe("11_50");
  });
});
