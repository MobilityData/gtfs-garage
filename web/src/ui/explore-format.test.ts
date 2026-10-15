import { describe, expect, it } from "vitest";

import type { RouteSummary, WeekdayProfile } from "../sources/types";
import {
  byMode,
  clock,
  count,
  expiry,
  routeBadge,
  routeLabel,
  routeSubtitle,
  span,
  swatch,
  textOn,
  weekdayBars,
} from "./explore-format";

const route = (overrides: Partial<RouteSummary> = {}): RouteSummary => ({
  route_id: "R1",
  short_name: "10",
  long_name: "Riverside",
  route_type: "3",
  mode: "Bus",
  color: "1E88E5",
  text_color: null,
  agency_id: "CITY",
  agency_name: "City Transit",
  trips: 10,
  services: 2,
  ...overrides,
});

describe("routeLabel", () => {
  it("prefers the short name, which is what is on the vehicle", () => {
    expect(routeLabel(route())).toBe("10");
  });

  it("falls back to the long name, then to the id", () => {
    expect(routeLabel(route({ short_name: "" }))).toBe("Riverside");
    expect(routeLabel(route({ short_name: null, long_name: null }))).toBe("R1");
  });
});

describe("routeSubtitle", () => {
  it("gives the long name as the second line", () => {
    expect(routeSubtitle(route())).toBe("Riverside");
  });

  it("does not repeat itself when the two names are the same", () => {
    expect(routeSubtitle(route({ short_name: "", long_name: "Riverside" }))).toBe("");
  });
});

/**
 * Feeds write `#FF0000`, `ff0000` and `red` into a field GTFS says is six hex
 * digits. Anything that is not is treated as absent rather than handed to the
 * browser, which would accept one of those and silently ignore the other.
 */
describe("swatch", () => {
  it("accepts six hex digits, with or without a hash", () => {
    expect(swatch("FF0000")).toBe("#ff0000");
    expect(swatch("#Ff0000")).toBe("#ff0000");
  });

  it("rejects anything else", () => {
    expect(swatch("red")).toBeNull();
    expect(swatch("ff00")).toBeNull();
    expect(swatch("")).toBeNull();
    expect(swatch(null)).toBeNull();
  });
});

describe("textOn", () => {
  it("puts white on a dark badge and black on a light one", () => {
    expect(textOn("#1e3a8a")).toBe("#fff");
    expect(textOn("#ffe066")).toBe("#111");
  });

  it("leaves an uncoloured badge to the stylesheet", () => {
    expect(textOn(null)).toBe("inherit");
  });
});

/**
 * GTFS means 25:40, and a display that shows it as 01:40 has moved the trip a
 * day - onto a service day it does not run on.
 */
describe("clock", () => {
  it("shortens a GTFS time to the part people read", () => {
    expect(clock("05:12:00")).toBe("05:12");
  });

  it("keeps an hour past midnight and says what it is", () => {
    expect(clock("25:40:00")).toBe("25:40 (after midnight)");
  });

  it("has something to show when the feed has no time", () => {
    expect(clock(null)).toBe("–");
  });
});

describe("span", () => {
  it("reads as a sentence", () => {
    expect(span("05:12:00", "23:40:00")).toBe("05:12 to 23:40");
  });

  it("says so when a feed states no times at all", () => {
    expect(span(null, null)).toBe("No times in this feed");
  });
});

describe("count", () => {
  it("says none rather than zero", () => {
    expect(count(0, "trip")).toBe("No trips");
  });

  it("agrees with itself", () => {
    expect(count(1, "trip")).toBe("1 trip");
    expect(count(4, "trip")).toBe("4 trips");
  });
});

describe("expiry", () => {
  it("is plain about a feed that has already run out", () => {
    expect(expiry(-3)).toEqual({ text: "Expired 3 days ago", tone: "gone" });
    expect(expiry(0)).toEqual({ text: "Ends today", tone: "gone" });
  });

  it("warns within a month and is calm beyond it", () => {
    expect(expiry(20).tone).toBe("warn");
    expect(expiry(200).tone).toBe("ok");
  });

  it("treats a missing end date as something to look at", () => {
    expect(expiry(null).tone).toBe("warn");
  });
});

describe("weekdayBars", () => {
  const profile = (name: string, typical: number): WeekdayProfile => ({
    weekday: 1,
    name,
    dates: 52,
    dates_with_service: 52,
    typical_trips: typical,
    max_trips: typical,
  });

  it("scales each day against the busiest one", () => {
    const bars = weekdayBars([profile("Monday", 100), profile("Sunday", 25)]);
    expect(bars.map((bar) => bar.share)).toEqual([1, 0.25]);
  });

  it("does not divide by a week with no service in it", () => {
    expect(weekdayBars([profile("Monday", 0)])[0].share).toBe(0);
  });
});

describe("byMode", () => {
  it("groups routes and puts the largest group first", () => {
    const grouped = byMode([
      route({ route_id: "A", mode: "Bus" }),
      route({ route_id: "B", mode: "Rail" }),
      route({ route_id: "C", mode: "Bus" }),
    ]);
    expect(grouped.map((group) => [group.mode, group.routes.length])).toEqual([
      ["Bus", 2],
      ["Rail", 1],
    ]);
  });

  it("keeps the order the list already had inside a group", () => {
    const grouped = byMode([route({ route_id: "A" }), route({ route_id: "B" })]);
    expect(grouped[0].routes.map((r) => r.route_id)).toEqual(["A", "B"]);
  });
});

/**
 * A badge is a short identifier. A demand-responsive feed states no short
 * names, and putting "Dial-A-Ride - general public" on one is not a badge -
 * the long name is already the row beside it.
 */
describe("routeBadge", () => {
  it("is the short name, which is what is on the vehicle", () => {
    expect(routeBadge(route())).toBe("10");
  });

  it("falls back to the id rather than to the long name", () => {
    expect(routeBadge(route({ short_name: null, long_name: "Dial-A-Ride - general public" }))).toBe("R1");
  });

  it("treats whitespace as absent", () => {
    expect(routeBadge(route({ short_name: "  " }))).toBe("R1");
  });
});
