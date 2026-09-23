export const EXPORT_SCHEMA_VERSION = 1;
export const EXPORT_DOWNLOAD_HOURS = 24;
export const EXPORT_RETENTION_DAYS = 7;
export const EXPORT_NEW_PER_DAY = 2;

export type ExportParseOk<T> = { ok: true; value: T };
export type ExportParseFail = { ok: false; field_errors: { field: string; message: string }[] };

export type ExportRequestInput = { newer: boolean };

export function parseExportRequest(raw: unknown): ExportParseOk<ExportRequestInput> | ExportParseFail {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: { newer: false } };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, field_errors: [{ field: "body", message: "A JSON object is required." }] };
  }
  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "newer")) {
    return { ok: false, field_errors: [{ field: "body", message: "Unknown fields are not allowed." }] };
  }
  if (body.newer === undefined) {
    return { ok: true, value: { newer: false } };
  }
  if (typeof body.newer !== "boolean") {
    return { ok: false, field_errors: [{ field: "newer", message: "newer must be true or false." }] };
  }
  return { ok: true, value: { newer: body.newer } };
}

export function csvFormulaSafeCell(value: string): string {
  let next = value;
  if (/^[=+\-@\t\r]/.test(next) || (next.length > 0 && next.charCodeAt(0) < 32)) {
    next = `'${next}`;
  }
  if (/[",\n\r]/.test(next)) {
    return `"${next.replaceAll('"', '""')}"`;
  }
  return next;
}

export function toCsvRow(cells: Array<string | number | boolean | null | undefined>): string {
  return cells
    .map((cell) => {
      if (cell === null || cell === undefined) {
        return "";
      }
      if (typeof cell === "number" || typeof cell === "boolean") {
        return String(cell);
      }
      return csvFormulaSafeCell(cell);
    })
    .join(",");
}

export function exportSizeBucket(bytes: number): "0_1mb" | "1_10mb" | "10_100mb" | "100mb_plus" {
  if (bytes < 1_000_000) {
    return "0_1mb";
  }
  if (bytes < 10_000_000) {
    return "1_10mb";
  }
  if (bytes < 100_000_000) {
    return "10_100mb";
  }
  return "100mb_plus";
}

export function exportJobCountBucket(count: number): "0" | "1_10" | "11_50" | "51_200" | "201_plus" {
  if (count <= 0) {
    return "0";
  }
  if (count <= 10) {
    return "1_10";
  }
  if (count <= 50) {
    return "11_50";
  }
  if (count <= 200) {
    return "51_200";
  }
  return "201_plus";
}
