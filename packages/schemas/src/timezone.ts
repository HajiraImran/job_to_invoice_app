const IANA = /^[A-Za-z0-9_+\-/]+$/;

export const US_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Puerto_Rico",
  "America/Boise",
  "America/Indiana/Indianapolis",
  "America/Detroit",
] as const;

export function isValidIanaTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 64 || !IANA.test(value)) {
    return false;
  }
  if (value !== "UTC" && !value.includes("/")) {
    return false;
  }
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function deviceTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidIanaTimeZone(zone) ? zone : undefined;
  } catch {
    return undefined;
  }
}

function zoneParts(instant: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }
  const hour = map.hour === "24" ? 0 : Number(map.hour);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

export function wallTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = new Date(utcGuess);
  const first = zoneParts(instant, timeZone);
  const firstAsUtc = Date.UTC(first.year, first.month - 1, first.day, first.hour, first.minute, first.second);
  instant = new Date(utcGuess - (firstAsUtc - instant.getTime()));
  const secondPass = zoneParts(instant, timeZone);
  const secondAsUtc = Date.UTC(
    secondPass.year,
    secondPass.month - 1,
    secondPass.day,
    secondPass.hour,
    secondPass.minute,
    secondPass.second,
  );
  return new Date(utcGuess - (secondAsUtc - instant.getTime()));
}

export function calendarDateInTimeZone(isoDate: string, timeZone: string, hour = 12): string {
  const parts = isoDate.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const utc = wallTimeToUtc(timeZone, year, month, day, hour, 0, 0);
  const zoned = zoneParts(utc, timeZone);
  return `${String(zoned.year).padStart(4, "0")}-${String(zoned.month).padStart(2, "0")}-${String(zoned.day).padStart(2, "0")}`;
}

export function naiveUtcMidnightCalendarDate(isoDate: string, timeZone: string): string {
  const utc = new Date(`${isoDate}T00:00:00.000Z`);
  const parts = zoneParts(utc, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function zonedCalendarDate(instant: Date, timeZone: string): string {
  const parts = zoneParts(instant, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function addCalendarDays(isoDate: string, days: number): string {
  const parts = isoDate.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const utc = Date.UTC(year, month - 1, day + days);
  const shifted = new Date(utc);
  return `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

export function endOfLocalDateUtc(isoDate: string, timeZone: string): Date {
  const parts = isoDate.split("-");
  return wallTimeToUtc(timeZone, Number(parts[0]), Number(parts[1]), Number(parts[2]), 23, 59, 59);
}
