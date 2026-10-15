import { describe, expect, it } from "vitest";

import type { CalendarDay, ServicePattern } from "../sources/types";
import { describeDate, destinations, longDate, patternNames, stepDate } from "./date-bar";

const day = (service_date: string, trips: number, services: string[] = ["WKDY"]): CalendarDay => ({
  service_date,
  weekday: new Date(`${service_date}T00:00:00Z`).getUTCDay(),
  services: trips ? services : [],
  trips,
  routes: trips ? 2 : 0,
});

const week = [
  day("2026-03-16", 100), // Monday
  day("2026-03-17", 100),
  day("2026-03-18", 100),
  day("2026-03-19", 100),
  day("2026-03-20", 100),
  day("2026-03-21", 40, ["SAT"]), // Saturday
  day("2026-03-22", 0), // Sunday, nothing runs
];

const patterns = [
  { name: "Weekdays", services: ["WKDY"], trips: 100 },
  { name: "Saturdays", services: ["SAT"], trips: 40 },
  { name: "No service", services: [], trips: 0 },
] as ServicePattern[];

describe("stepDate", () => {
  it("moves one day", () => {
    expect(stepDate(week, "2026-03-18", 1)).toBe("2026-03-19");
    expect(stepDate(week, "2026-03-18", -1)).toBe("2026-03-17");
  });

  it("stops at the ends rather than leaving the feed", () => {
    expect(stepDate(week, "2026-03-16", -1)).toBe("2026-03-16");
    expect(stepDate(week, "2026-03-22", 1)).toBe("2026-03-22");
  });

  it("leaves a date the feed does not contain alone", () => {
    expect(stepDate(week, "2030-01-01", 1)).toBe("2030-01-01");
  });
});

/**
 * What replaced a "Next change" button that did something abstract: a list of
 * places worth going, each naming the date it lands on, so choosing one is
 * choosing a day rather than trusting a rule.
 */
describe("destinations", () => {
  it("offers today when the feed covers it", () => {
    const found = destinations(week, patterns, "2026-03-18");
    expect(found[0]).toMatchObject({ label: "Today", date: "2026-03-18" });
  });

  it("leaves today out when nothing runs then", () => {
    const labels = destinations(week, patterns, "2026-03-22").map((entry) => entry.label);
    expect(labels).not.toContain("Today");
  });

  it("offers the next day of each kind, with its real date", () => {
    const found = destinations(week, patterns, "2026-03-16");
    expect(found).toContainEqual({ label: "Next Saturdays", date: "2026-03-21", note: "Saturdays" });
  });

  it("does not offer a kind of day on which nothing runs", () => {
    const labels = destinations(week, patterns, "2026-03-16").map((entry) => entry.label);
    expect(labels).not.toContain("Next No service");
  });

  it("names the edges of the feed", () => {
    const found = destinations(week, patterns, "2026-03-18");
    expect(found).toContainEqual(expect.objectContaining({ label: "First day of the feed", date: "2026-03-16" }));
  });

  it("offers one row per date, so an edge that is already listed is not repeated", () => {
    // The feed's last running day is 2026-03-21, which "Next saturdays"
    // already lands on. Two rows with the same date read as a fault.
    const found = destinations(week, patterns, "2026-03-18");
    const lastDay = found.filter((entry) => entry.date === "2026-03-21");
    expect(lastDay).toHaveLength(1);
  });

  it("never offers the same date twice", () => {
    const dates = destinations(week, patterns, "2026-03-16").map((entry) => entry.date);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it("has nothing to offer for a feed with no dates", () => {
    expect(destinations([], patterns, "2026-03-18")).toEqual([]);
  });

  it("looks forward from the day being viewed, not from today", () => {
    const found = destinations(week, patterns, "2026-03-16", "2026-03-20");
    expect(found).toContainEqual(expect.objectContaining({ label: "Next Weekdays", date: "2026-03-20" }));
  });
});

describe("patternNames", () => {
  it("names a day by the services running on it", () => {
    const named = patternNames(week, patterns);
    expect(named.get("2026-03-16")).toBe("Weekdays");
    expect(named.get("2026-03-21")).toBe("Saturdays");
  });
});

describe("describeDate", () => {
  it("says what kind of day it is and how much runs", () => {
    expect(describeDate(week[0], "Weekdays")).toBe("Weekdays · 2 routes · 100 trips");
  });

  it("is plain about a day with nothing on it", () => {
    expect(describeDate(week[6], undefined)).toBe("No service — nothing runs");
  });

  it("agrees with itself on a single route", () => {
    expect(describeDate({ ...week[0], routes: 1, trips: 1 }, "Weekdays")).toBe("Weekdays · 1 route · 1 trip");
  });

  it("says so when the date is not in the feed", () => {
    expect(describeDate(undefined, undefined)).toBe("That date is outside this feed");
  });
});

/** Spelled out rather than from a locale: the same words on every machine. */
describe("longDate", () => {
  it("names the weekday, the day, the month and the year", () => {
    expect(longDate("2026-03-19")).toBe("Thursday 19 March 2026");
  });

  it("leaves something it cannot read alone", () => {
    expect(longDate("not a date")).toBe("not a date");
  });
});
