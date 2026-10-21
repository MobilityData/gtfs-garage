import { describe, expect, it } from "vitest";

import type { TableInfo } from "../sources/types";
import { contrastRatio } from "./explainers";
import { isLocated, locate } from "./locate";

describe("colour contrast", () => {
  it("is measured as accessibility guidelines measure it", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
    // White on a mid blue passes; yellow on white does not.
    expect(contrastRatio("#0055A4", "#FFFFFF")).toBeGreaterThan(4.5);
    expect(contrastRatio("#FFFF00", "#FFFFFF")).toBeLessThan(1.5);
  });
});

describe("rows in one of several files", () => {
  const table = (name: string, columns: string[]) =>
    ({ name, row_count: 1, lines: "exact", forbidden: null, columns: columns.map((column) => ({ name: column, related: [], enum_like: false })) }) as unknown as TableInfo;

  it("opens the first file the feed has, among those the validator names", () => {
    const onlyDates = [table("calendar_dates", ["service_id", "date", "exception_type"])];
    const found = locate({ file: "calendar.txt or calendar_dates.txt", key: { service_id: "WK" } }, onlyDates);
    expect(isLocated(found) && found.table).toBe("calendar_dates");
  });

  it("prefers the one with the columns the key names", () => {
    const both = [table("calendar", ["service_id", "monday"]), table("calendar_dates", ["service_id", "date"])];
    const found = locate({ file: "calendar.txt or calendar_dates.txt", key: { date: "20261015" } }, both);
    expect(isLocated(found) && found.table).toBe("calendar_dates");
  });

  it("says when the feed has none of them", () => {
    const found = locate({ file: "calendar.txt or calendar_dates.txt", key: { service_id: "WK" } }, []);
    expect(isLocated(found) ? null : found.problem).toBe("This feed has none of calendar.txt or calendar_dates.txt.");
  });
});

describe("formatters for readers", () => {
  it("say the validator's capitals, positions, durations and days in words", async () => {
    const { fill } = await import("./template");
    expect(fill("{{v|words}}", { v: "BUS, RAIL" })).toBe("bus, rail");
    expect(fill("{{v|words}}", { v: "ACCESSIBLE_VIA_PATHWAYS" })).toBe("accessible via pathways");
    expect(fill("{{v|from1}}", { v: 0 })).toBe("1");
    expect(fill("{{v|min}}", { v: 5400 })).toBe("90 min");
    expect(fill("{{v|days}}", { v: 1 })).toBe("1 day");
    expect(fill("{{v|days}}", { v: 5 })).toBe("5 days");
    expect(fill("{{v|yesno}}", { v: false })).toBe("no");
    expect(fill("{{v|coord}}", { v: -73.58999999999999 })).toBe("-73.59");
    expect(fill("{{v|round}}", { v: 1170.0000001 })).toBe("1,170");
    expect(fill("{{v|m}}", { v: 0.53 })).toBe("0.5 m");
    expect(fill("{{v|m}}", { v: 412.6 })).toBe("413 m");
  });
});
