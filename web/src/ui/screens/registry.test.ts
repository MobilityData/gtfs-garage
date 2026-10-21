import { describe, expect, it } from "vitest";

import type { ViewerSource } from "../../sources/types";
import { availableScreens, defaultScreens, listedScreens, type Screen } from "./index";

/** A source that answers only the table endpoints, as a Parquet reader does. */
const tablesOnly = {
  tables: async () => ({ source: "", tables: [] }),
  query: async () => ({ columns: [], rows: [], total: 0, page: 1, page_size: 100 }),
  distinct: async () => [],
  geojson: async () => ({ type: "FeatureCollection", features: [] }),
  geojsonStream: async () => {},
} as unknown as ViewerSource;

/** One that answers everything the built-in screens ask for. */
const everything = {
  ...tablesOnly,
  overview: async () => ({}),
  calendar: async () => ({}),
  routes: async () => [],
  route: async () => ({}),
  timetable: async () => ({}),
} as unknown as ViewerSource;

const screen = (id: string, label?: string, available = true): Screen => ({
  id,
  label,
  available: () => available,
  fetch: async () => ({}),
  render: () => ({}) as HTMLElement,
});

describe("defaultScreens", () => {
  it("ships the four listed views, the detail screens behind them, and Tours", () => {
    expect(defaultScreens.map((s) => s.id)).toEqual([
      "overview",
      "calendar",
      "routes",
      "quality",
      "route",
      "timetable",
      "tours",
    ]);
  });

  it("leaves the detail screens out of the sidebar, having no route in mind", () => {
    expect(listedScreens(defaultScreens).map((s) => s.id)).toEqual(["overview", "calendar", "routes", "quality"]);
  });

  it("says where each screen wants the map", () => {
    const layout = Object.fromEntries(defaultScreens.map((s) => [s.id, s.layout ?? "beside"]));
    // The overview has nothing to draw; the timetable needs the width a side
    // map would take, so the map becomes a band over it.
    expect(layout).toEqual({
      overview: "none",
      calendar: "none",
      routes: "beside",
      quality: "beside",
      route: "beside",
      timetable: "above",
      tours: "none",
    });
  });

  it("explains each listed entry, since the labels alone are not self-evident", () => {
    expect(listedScreens(defaultScreens).every((s) => (s.title ?? "").length > 10)).toBe(true);
  });
});

/**
 * The property that keeps every integration honest: a source decides what it
 * can answer, and a screen it cannot answer is never offered. This is what lets
 * a browser source reading Parquet show the file browser alone rather than
 * entries that lead to an error.
 */
describe("availableScreens", () => {
  it("offers only Quality to a source that only serves tables", () => {
    // Quality reads a report and opens rows; a source that serves tables can
    // do both, so it is the one derived view such a source can still answer.
    // Tours needs nothing of the feed at all.
    expect(availableScreens(defaultScreens, tablesOnly).map((s) => s.id)).toEqual(["quality", "tours"]);
  });

  it("offers all of them to a source that answers all of them", () => {
    expect(availableScreens(defaultScreens, everything)).toHaveLength(7);
  });

  it("leaves out the timetable for a source written before it existed", () => {
    // Optional on its own, unlike the four that arrived together: an older
    // source keeps every view it had and simply does not offer this one.
    const { timetable, ...older } = everything as unknown as Record<string, unknown>;
    void timetable;
    const ids = availableScreens(defaultScreens, older as unknown as ViewerSource).map((s) => s.id);
    expect(ids).not.toContain("timetable");
    expect(ids).toContain("route");
  });

  it("keeps the order it was given, which is the order the sidebar shows", () => {
    const ordered = [screen("c", "C"), screen("a", "A"), screen("b", "B")];
    expect(availableScreens(ordered, tablesOnly).map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  it("drops a screen whose own predicate says no", () => {
    const mixed = [screen("yes", "Yes"), screen("no", "No", false)];
    expect(availableScreens(mixed, tablesOnly).map((s) => s.id)).toEqual(["yes"]);
  });

  it("treats a host predicate that throws as a no rather than failing the feed", () => {
    const broken: Screen = {
      ...screen("broken", "Broken"),
      available: () => {
        throw new Error("a host's bug");
      },
    };
    expect(() => availableScreens([broken, screen("fine", "Fine")], tablesOnly)).not.toThrow();
    expect(availableScreens([broken, screen("fine", "Fine")], tablesOnly).map((s) => s.id)).toEqual(["fine"]);
  });
});

/** The three things a host is meant to be able to do with the list. */
describe("a host's own screens", () => {
  it("can add one", () => {
    const theirs = [...defaultScreens, screen("fares", "Fares")];
    expect(availableScreens(theirs, everything).map((s) => s.id)).toContain("fares");
  });

  it("can replace one of ours", () => {
    const theirs = defaultScreens.map((s) => (s.id === "calendar" ? screen("calendar", "Their calendar") : s));
    const calendar = availableScreens(theirs, everything).find((s) => s.id === "calendar");
    expect(calendar?.label).toBe("Their calendar");
  });

  it("can drop them all, leaving the file browser", () => {
    expect(availableScreens([], everything)).toEqual([]);
  });
});
