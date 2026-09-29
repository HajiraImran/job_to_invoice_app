import { describe, expect, it } from "vitest";
import {
  CURATED_TIMEZONES,
  confirmTimeZoneSelection,
  filterTimeZones,
  formatTimeZoneOption,
  formatUtcOffset,
  isValidIanaTimeZone,
  listTimeZones,
  suggestedBusinessTimeZone,
  timeZoneCityLabel,
} from "./timezone.ts";

describe("timezone catalog and presentation", () => {
  it("keeps a curated IANA catalog when a runtime list is unavailable", () => {
    expect(CURATED_TIMEZONES).toContain("America/Chicago");
    expect(CURATED_TIMEZONES).toContain("Asia/Karachi");
    expect(listTimeZones(["Asia/Karachi"])).toContain("Asia/Karachi");
    expect(listTimeZones(["not-a-zone"])).not.toContain("not-a-zone");
  });

  it("stores IANA identifiers and presents a DST-aware UTC offset", () => {
    expect(isValidIanaTimeZone("Asia/Karachi")).toBe(true);
    expect(formatUtcOffset("Asia/Karachi", new Date("2026-01-15T12:00:00.000Z"))).toBe("UTC+05:00");
    expect(formatUtcOffset("America/New_York", new Date("2026-01-15T12:00:00.000Z"))).toBe("UTC-05:00");
    expect(formatUtcOffset("America/New_York", new Date("2026-07-15T12:00:00.000Z"))).toBe("UTC-04:00");
    expect(formatTimeZoneOption("Asia/Karachi", new Date("2026-06-01T00:00:00.000Z"))).toBe(
      "Asia/Karachi (UTC+05:00)",
    );
  });

  it("filters by identifier, city text, and offset without case sensitivity", () => {
    const zones = ["America/Chicago", "Asia/Karachi", "Europe/London"];
    expect(filterTimeZones(zones, "karachi")).toEqual(["Asia/Karachi"]);
    expect(filterTimeZones(zones, "CHICAGO")).toEqual(["America/Chicago"]);
    expect(filterTimeZones(zones, "utc+05:00", new Date("2026-01-15T12:00:00.000Z"))).toEqual(["Asia/Karachi"]);
    expect(filterTimeZones(zones, "not-a-city")).toEqual([]);
    expect(timeZoneCityLabel("America/Indiana/Indianapolis")).toBe("Indianapolis");
  });

  it("prefers a saved timezone and does not overwrite it with the device zone", () => {
    expect(suggestedBusinessTimeZone("Asia/Karachi", "America/Chicago")).toBe("Asia/Karachi");
    expect(suggestedBusinessTimeZone("EST", "America/Chicago")).toBe("America/Chicago");
    expect(suggestedBusinessTimeZone("", null)).toBe("America/New_York");
    expect(confirmTimeZoneSelection("Europe/London", "America/Chicago")).toBe("Europe/London");
    expect(confirmTimeZoneSelection(undefined, "America/Chicago")).toBe("America/Chicago");
    expect(confirmTimeZoneSelection("EST", "America/Chicago")).toBe("America/Chicago");
  });
});
