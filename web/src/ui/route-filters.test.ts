import { describe, expect, it } from "vitest";

import type { RouteSummary } from "../sources/types";
import {
  anyOn,
  applyFilters,
  describeFilters,
  facets,
  isOn,
  onlyFacets,
  toggle,
} from "./route-filters";

const route = (over: Partial<RouteSummary> & { route_id: string }): RouteSummary => ({
  mode: "Bus",
  route_type: "3",
  trips: 20,
  services: 2,
  short_name: "1",
  long_name: "A line",
  color: "FF0000",
  text_color: "FFFFFF",
  agency_id: "CT",
  agency_name: "City Transit",
  ...over,
});

/** Four routes that differ in every way a facet reads. */
const feed: RouteSummary[] = [
  route({ route_id: "2", short_name: "2", trips: 13, services: 1 }),
  route({ route_id: "10", short_name: "10", trips: 71, services: 2 }),
  route({ route_id: "101", short_name: "101", trips: 3, services: 1, color: null }),
  route({
    route_id: "RL",
    short_name: null,
    mode: "Rail",
    route_type: "2",
    trips: 220,
    services: 1,
    agency_id: "RR",
    agency_name: "Regional Rail",
  }),
];

describe("applyFilters", () => {
  it("leaves the list alone when nothing is chosen", () => {
    expect(applyFilters(feed, {})).toHaveLength(4);
  });

  it("narrows by mode", () => {
    expect(applyFilters(feed, { mode: "3" }).map((entry) => entry.route_id)).toEqual(["2", "10", "101"]);
  });

  it("reads several values of one facet as an or", () => {
    expect(applyFilters(feed, { mode: "3,2" })).toHaveLength(4);
  });

  it("reads two facets as an and", () => {
    expect(applyFilters(feed, { mode: "3", agency: "RR" })).toHaveLength(0);
  });

  it("reads several flags as an and, because each is a separate thing to notice", () => {
    expect(applyFilters(feed, { flag: "no-colour,one-service" }).map((entry) => entry.route_id)).toEqual(["101"]);
    expect(applyFilters(feed, { flag: "no-colour,no-short-name" })).toHaveLength(0);
  });

  it("bands routes by trips at the edges of each band", () => {
    const banded = (value: string) => applyFilters(feed, { trips: value }).map((entry) => entry.route_id);
    expect(banded("few")).toEqual(["101"]); // 3
    expect(banded("some")).toEqual(["2"]); // 13
    expect(banded("many")).toEqual(["10"]); // 71
    expect(banded("most")).toEqual(["RL"]); // 220
  });

  it("puts a route with no trips in its own band rather than in 'under 10'", () => {
    const quiet = [...feed, route({ route_id: "X", trips: 0 })];
    expect(applyFilters(quiet, { trips: "none" }).map((entry) => entry.route_id)).toEqual(["X"]);
    expect(applyFilters(quiet, { trips: "few" }).map((entry) => entry.route_id)).toEqual(["101"]);
  });

  it("ignores a value no option uses rather than emptying the list", () => {
    expect(applyFilters(feed, { flag: "not-a-flag" })).toHaveLength(4);
  });
});

describe("facets", () => {
  it("offers mode, agency, trips and flags for a feed that varies", () => {
    expect(facets(feed, {}).map((facet) => facet.key)).toEqual(["mode", "agency", "trips", "flag"]);
  });

  it("counts each option over the whole list when nothing is filtered", () => {
    const mode = facets(feed, {}).find((facet) => facet.key === "mode")!;
    expect(mode.options).toEqual([
      { value: "3", label: "Bus", count: 3 },
      { value: "2", label: "Rail", count: 1 },
    ]);
  });

  /** The counts are the point: they say what clicking would give you. */
  it("counts an option against the list narrowed by every other facet", () => {
    const agency = facets(feed, { mode: "3" }).find((facet) => facet.key === "agency")!;
    expect(agency.options).toContainEqual({ value: "CT", label: "City Transit", count: 3 });
    expect(agency.options).toContainEqual({ value: "RR", label: "Regional Rail", count: 0 });
  });

  it("counts a facet's own options as if it were not filtering, so the chosen one keeps its number", () => {
    const mode = facets(feed, { mode: "2" }).find((facet) => facet.key === "mode")!;
    expect(mode.options.find((option) => option.value === "3")!.count).toBe(3);
  });

  it("leaves out a facet that cannot change anything", () => {
    const buses = feed.filter((entry) => entry.mode === "Bus");
    expect(facets(buses, {}).map((facet) => facet.key)).not.toContain("mode");
    expect(facets(buses, {}).map((facet) => facet.key)).not.toContain("agency");
  });

  it("leaves out a trip band no route is in", () => {
    const bands = facets(feed, {}).find((facet) => facet.key === "trips")!;
    expect(bands.options.map((option) => option.value)).toEqual(["few", "some", "many", "most"]);
  });

  it("offers a flag only when some route has it", () => {
    const flags = facets(feed, {}).find((facet) => facet.key === "flag")!;
    expect(flags.options.map((option) => option.value)).toEqual(["no-colour", "no-short-name", "one-service"]);
  });

  it("shows the busiest option first", () => {
    const mode = facets(feed, {}).find((facet) => facet.key === "mode")!;
    expect(mode.options[0].label).toBe("Bus");
  });

  it("has nothing to offer for an empty list", () => {
    expect(facets([], {})).toEqual([]);
  });
});

describe("toggle", () => {
  it("turns an option on", () => {
    expect(toggle({}, "mode", "3")).toEqual({ mode: "3" });
  });

  it("adds a second value to the same facet", () => {
    expect(toggle({ mode: "3" }, "mode", "2")).toEqual({ mode: "3,2" });
  });

  it("turns an option off again", () => {
    expect(toggle({ mode: "3,2" }, "mode", "3")).toEqual({ mode: "2" });
  });

  it("removes the key rather than leaving it empty", () => {
    expect(toggle({ mode: "3" }, "mode", "3")).toEqual({});
  });

  it("leaves other facets alone", () => {
    expect(toggle({ agency: "CT" }, "mode", "3")).toEqual({ agency: "CT", mode: "3" });
  });
});

describe("isOn and anyOn", () => {
  it("knows what is in force", () => {
    expect(isOn({ mode: "3,2" }, "mode", "2")).toBe(true);
    expect(isOn({ mode: "3" }, "mode", "2")).toBe(false);
  });

  it("ignores parameters this screen does not own", () => {
    expect(anyOn({ page: "3" })).toBe(false);
    expect(anyOn({ flag: "no-colour" })).toBe(true);
  });
});

describe("onlyFacets", () => {
  it("keeps the keys this screen owns and drops the rest", () => {
    expect(onlyFacets({ mode: "3", trips: "few", page: "2", q: "hill" })).toEqual({ mode: "3", trips: "few" });
  });
});

describe("describeFilters", () => {
  it("names what is in force, in the words on the chips", () => {
    expect(describeFilters(feed, { mode: "3", flag: "no-colour" })).toBe("Bus · No colour");
  });

  it("says nothing when nothing is in force", () => {
    expect(describeFilters(feed, {})).toBe("");
  });

  it("names every value of a facet with more than one", () => {
    expect(describeFilters(feed, { mode: "3,2" })).toBe("Bus · Rail");
  });
});
