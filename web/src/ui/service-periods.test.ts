import { describe, expect, it } from "vitest";

import type { ServicePattern } from "../sources/types";
import { changes, describeChange, periods } from "./service-periods";

const pattern = (over: Partial<ServicePattern>): ServicePattern =>
  ({
    name: "Weekdays",
    services: ["WKDY"],
    trips: 100,
    routes: 2,
    days: 100,
    weekdays: [1, 2, 3, 4, 5],
    first_date: "2021-07-02",
    last_date: "2022-09-01",
    sample_dates: [],
    ...over,
  }) as ServicePattern;

/**
 * A year grid cannot show a feed running to 2100. A time axis can show any of
 * them, and what is worth seeing - where one schedule ends and the next begins
 * - is where the bands stop and start.
 */
describe("periods", () => {
  const first = "2021-07-02";
  const last = "2024-01-01";

  it("places a band across the share of the window it covers", () => {
    const [band] = periods([pattern({ first_date: first, last_date: last })], first, last);
    expect(band.start).toBeCloseTo(0, 5);
    expect(band.width).toBeCloseTo(1, 5);
  });

  it("starts a later pattern further along", () => {
    const [band] = periods([pattern({ first_date: "2022-09-02", last_date: last })], first, last);
    expect(band.start).toBeGreaterThan(0.4);
    expect(band.start + band.width).toBeCloseTo(1, 2);
  });

  it("leaves a single-date pattern wide enough to see", () => {
    const [band] = periods([pattern({ first_date: "2022-01-01", last_date: "2022-01-01" })], first, last);
    expect(band.width).toBeGreaterThan(0);
  });

  it("leaves out the days nothing runs on", () => {
    // "No service" is the absence of the others, not a period of its own; a
    // band for it would cover every gap in every other band.
    const bands = periods([pattern({ name: "No service", services: [], trips: 0 })], first, last);
    expect(bands).toEqual([]);
  });

  it("puts the longest-running kind of day first", () => {
    const bands = periods(
      [pattern({ name: "Short", days: 10 }), pattern({ name: "Long", days: 300 })],
      first,
      last,
    );
    expect(bands.map((band) => band.name)).toEqual(["Long", "Short"]);
  });
});

/**
 * Not "every date whose services differ from yesterday's" - that is every
 * Saturday. A period's own boundaries are the moments the timetable was
 * actually replaced.
 */
describe("changes", () => {
  const first = "2021-07-02";
  const last = "2024-01-01";

  it("reports the date one kind of day gives way to another", () => {
    const found = changes(
      [
        pattern({ name: "Weekdays", first_date: first, last_date: "2022-09-01" }),
        pattern({ name: "Mon, Tue, Wed, Fri", first_date: "2022-09-02", last_date: last }),
      ],
      first,
      last,
    );

    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({
      date: "2022-09-02",
      begins: ["Mon, Tue, Wed, Fri"],
      ends: ["Weekdays"],
    });
  });

  it("dates an ending to the first day the old schedule no longer applies", () => {
    const found = changes([pattern({ last_date: "2022-09-01" })], first, last);
    expect(found[0].date).toBe("2022-09-02");
  });

  it("does not call the feed's own edges a change", () => {
    // A pattern running the whole feed changed nothing; it is the feed.
    expect(changes([pattern({ first_date: first, last_date: last })], first, last)).toEqual([]);
  });

  it("ignores a kind of day on which nothing runs", () => {
    const quiet = pattern({ name: "No service", trips: 0, first_date: "2022-05-18", last_date: "2022-05-18" });
    expect(changes([quiet], first, last)).toEqual([]);
  });

  it("puts them in date order", () => {
    const found = changes(
      [
        pattern({ name: "Later", first_date: "2023-01-01", last_date: last }),
        pattern({ name: "Earlier", first_date: "2022-01-01", last_date: last }),
      ],
      first,
      last,
    );
    expect(found.map((entry) => entry.date)).toEqual(["2022-01-01", "2023-01-01"]);
  });
});

describe("describeChange", () => {
  it("says what began and what ended", () => {
    expect(describeChange({ date: "x", begins: ["B"], ends: ["A"] })).toBe("B begins · A ends");
  });

  it("says only the half that happened", () => {
    expect(describeChange({ date: "x", begins: ["B"], ends: [] })).toBe("B begins");
    expect(describeChange({ date: "x", begins: [], ends: ["A"] })).toBe("A ends");
  });
});
