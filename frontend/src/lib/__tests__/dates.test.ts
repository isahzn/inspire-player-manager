// T-UI-01 — date/time helper unit tests (TESTING_AND_ACCEPTANCE §2.1).
// Business dates are academy-local strings and must never be parsed with
// `new Date(str)`; instants are rendered in the academy timezone. These tests
// pin the month/year boundaries, the leap day and the tz conversion both ways.
import { describe, expect, it } from "vitest";
import {
  academyDateOf,
  academyLocalToInstant,
  academyTime,
  addDaysISO,
  addMinutes,
  ageOn,
  firstOfNextMonthISO,
  formatDateRange,
  formatDateStr,
  formatDuration,
  minutesBetween,
  parseDateStr,
  signedMinutes,
  todayISO,
} from "../dates";

describe("business dates", () => {
  it("parses and formats without touching a timezone", () => {
    expect(parseDateStr("2026-11-03")).toEqual({ y: 2026, m: 11, d: 3 });
    expect(parseDateStr("2026-13-03")).toBeNull();
    expect(parseDateStr("03/11/2026")).toBeNull();
    expect(formatDateStr("2026-11-03")).toBe("3 Nov 2026");
    expect(formatDateStr(null)).toBe("—");
    expect(formatDateRange("2026-11-01", "2026-11-30")).toBe("1 Nov 2026 – 30 Nov 2026");
  });

  it("adds days across month, year and leap boundaries", () => {
    expect(addDaysISO("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDaysISO("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysISO("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDaysISO("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysISO("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDaysISO("nonsense", 1)).toBe("");
  });

  it("computes the first of next month and ages on a reference date", () => {
    expect(firstOfNextMonthISO("2026-12-15")).toBe("2027-01-01");
    expect(firstOfNextMonthISO("2026-11-01")).toBe("2026-12-01");
    expect(ageOn("2015-03-14", "2026-01-01")).toBe(10);
    expect(ageOn("2015-03-14", "2026-03-14")).toBe(11);
    expect(ageOn("2015-03-14", "2026-03-13")).toBe(10);
  });

  it("takes 'today' from the academy timezone, not the device clock", () => {
    // 2026-11-01T20:00Z is already 02 Nov in Asia/Colombo (UTC+05:30).
    expect(todayISO(new Date("2026-11-01T20:00:00Z"))).toBe("2026-11-02");
    expect(todayISO(new Date("2026-11-01T18:00:00Z"))).toBe("2026-11-01");
  });
});

describe("academy timezone instants", () => {
  it("converts academy wall-clock time to a UTC instant and back", () => {
    expect(academyLocalToInstant("2026-11-03", "16:00")).toBe("2026-11-03T10:30:00.000Z");
    expect(academyTime("2026-11-03T10:30:00.000Z")).toBe("16:00");
    expect(academyDateOf("2026-11-03T18:45:00.000Z")).toBe("2026-11-04");
    expect(academyLocalToInstant("2026-11-03", "nope")).toBe("");
  });

  it("measures durations between instants", () => {
    expect(minutesBetween("2026-11-03T10:00:00Z", "2026-11-03T11:50:00Z")).toBe(110);
    expect(formatDuration(110)).toBe("1 h 50 m");
    expect(formatDuration(120)).toBe("2 h");
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(0)).toBe("0 min");
    expect(signedMinutes("2026-11-03T10:00:00Z", "2026-11-03T09:30:00Z")).toBe(-30);
    expect(addMinutes("2026-11-03T10:00:00Z", 90)).toBe("2026-11-03T11:30:00.000Z");
  });
});
