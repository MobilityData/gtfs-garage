import { describe, expect, it } from "vitest";

import type { CalendarDay } from "../sources/types";
import { column, describeDay, gaps, level, monthGrids } from "./calendar-grid";

const day = (service_date: string, trips: number, services: string[] = ["WKDY"]): CalendarDay => ({
  service_date,
  // 2026-01-01 is a Thursday; the fixtures below state their own weekday.
  weekday: new Date(`${service_date}T00:00:00Z`).getUTCDay(),
  services: trips ? services : [],
  trips,
  routes: trips ? 1 : 0,
});

describe("column", () => {
  it("moves Sunday to the end, because a calendar is read Monday first", () => {
    expect(column(1)).toBe(0);
    expect(column(0)).toBe(6);
  });
});

/**
 * Banded rather than linear: one enormous special-event day in a feed would
 * otherwise flatten every ordinary day to the same shade.
 */
describe("level", () => {
  it("gives nothing at all its own level", () => {
    expect(level(0, 100)).toBe(0);
  });

  it("puts a quarter of the busiest day at the bottom band", () => {
    expect(level(20, 100)).toBe(1);
    expect(level(40, 100)).toBe(2);
    expect(level(60, 100)).toBe(3);
    expect(level(100, 100)).toBe(4);
  });

  it("does not divide by a busiest day of nothing", () => {
    expect(level(5, 0)).toBe(1);
  });
});

describe("monthGrids", () => {
  const january = [day("2026-01-01", 10), day("2026-01-02", 10), day("2026-01-03", 0), day("2026-01-05", 10)];

  it("splits the days into months", () => {
    const grids = monthGrids([...january, day("2026-02-02", 10)]);
    expect(grids.map((grid) => grid.label)).toEqual(["January 2026", "February 2026"]);
  });

  it("pads the first week so the 1st sits under its own weekday", () => {
    const [grid] = monthGrids(january);
    // 2026-01-01 is a Thursday: three blanks before it.
    expect(grid.weeks[0].slice(0, 3).every((cell) => cell.day === null)).toBe(true);
    expect(grid.weeks[0][3].day?.service_date).toBe("2026-01-01");
  });

  it("starts a new row when the week turns over", () => {
    const [grid] = monthGrids(january);
    expect(grid.weeks).toHaveLength(2);
    expect(grid.weeks[1][0].day?.service_date).toBe("2026-01-05");
  });

  it("keeps a day with no service in the grid, shaded as empty", () => {
    const [grid] = monthGrids(january);
    const saturday = grid.weeks[0][5];
    expect(saturday.day?.service_date).toBe("2026-01-03");
    expect(saturday.level).toBe(0);
  });
});

describe("describeDay", () => {
  it("says plainly when nothing runs", () => {
    expect(describeDay(day("2026-01-03", 0))).toBe("2026-01-03: no service");
  });

  it("names the services behind a day's trips", () => {
    expect(describeDay(day("2026-01-01", 42, ["WKDY"]))).toBe("2026-01-01: 42 trips (WKDY)");
  });

  it("stops listing services before the tooltip becomes a wall", () => {
    const many = day("2026-01-01", 42, ["A", "B", "C", "D", "E", "F"]);
    expect(describeDay(many)).toContain("…");
  });
});

/**
 * A single quiet Sunday is a schedule. Eleven quiet days in July is a shutdown
 * or a mistake, and it is the first thing to look at.
 */
describe("gaps", () => {
  const days = [
    day("2026-01-01", 10),
    day("2026-01-02", 0),
    day("2026-01-03", 0),
    day("2026-01-04", 0),
    day("2026-01-05", 10),
    day("2026-01-06", 0),
    day("2026-01-07", 10),
  ];

  it("finds runs of days with nothing running", () => {
    expect(gaps(days)).toEqual([{ from: "2026-01-02", to: "2026-01-04", days: 3 }]);
  });

  it("ignores runs shorter than the minimum", () => {
    expect(gaps(days, 4)).toEqual([]);
  });

  it("closes a gap that runs to the end of the feed", () => {
    expect(gaps([day("2026-01-01", 10), day("2026-01-02", 0), day("2026-01-03", 0)])).toEqual([
      { from: "2026-01-02", to: "2026-01-03", days: 2 },
    ]);
  });

  it("puts the longest first", () => {
    const mixed = [
      day("2026-01-01", 0),
      day("2026-01-02", 0),
      day("2026-01-03", 10),
      day("2026-01-04", 0),
      day("2026-01-05", 0),
      day("2026-01-06", 0),
      day("2026-01-07", 10),
    ];
    expect(gaps(mixed).map((gap) => gap.days)).toEqual([3, 2]);
  });
});
