import { describe, expect, it } from "vitest";

import { initialView, Navigator } from "./navigation";

describe("urlFor", () => {
  it("always carries the table and page", () => {
    expect(Navigator.urlFor({ table: "stops", filters: [], page: 2 })).toBe("?table=stops&page=2");
  });

  it("omits filters when there are none", () => {
    expect(Navigator.urlFor({ table: "stops", filters: [], page: 1 })).not.toContain("filters");
  });

  it("encodes filters so a filtered view can be shared", () => {
    const url = Navigator.urlFor({
      table: "trips",
      filters: [{ column: "route_id", op: "eq", value: "R1" }],
      page: 1,
    });
    expect(Navigator.parseUrl(url)).toEqual({
      table: "trips",
      filters: [{ column: "route_id", op: "eq", value: "R1" }],
      page: 1,
    });
  });
});

describe("parseUrl", () => {
  it("returns null without a table", () => {
    expect(Navigator.parseUrl("?page=3")).toBeNull();
  });

  it("defaults the page to 1", () => {
    expect(Navigator.parseUrl("?table=stops")?.page).toBe(1);
  });

  it("defaults an unparseable page to 1", () => {
    expect(Navigator.parseUrl("?table=stops&page=abc")?.page).toBe(1);
  });

  it("falls back to no filters when the parameter is malformed", () => {
    expect(Navigator.parseUrl("?table=stops&filters=not-json")?.filters).toEqual([]);
  });

  it("ignores a filters parameter that is not a list", () => {
    expect(Navigator.parseUrl('?table=stops&filters={"column":"x"}')?.filters).toEqual([]);
  });
});

describe("initialView", () => {
  const tables = (...names: string[]) =>
    names.map((name) => ({ name, row_count: 0, columns: [] }));

  it("returns null for a feed with no tables", () => {
    expect(initialView([])).toBeNull();
  });

  it("lands on feed_info when the feed has one", () => {
    expect(initialView(tables("routes", "agency", "feed_info"))?.table).toBe("feed_info");
  });

  it("falls back to agency, then routes, then whatever is first", () => {
    expect(initialView(tables("routes", "agency"))?.table).toBe("agency");
    expect(initialView(tables("stops", "routes"))?.table).toBe("routes");
    expect(initialView(tables("stop_times", "shapes"))?.table).toBe("stop_times");
  });

  it("starts with no filters", () => {
    expect(initialView(tables("feed_info"))?.filters).toEqual([]);
    expect(initialView(tables("feed_info"))?.page).toBe(1);
  });

  it("restores a view when asked and the table is present", () => {
    const saved = { table: "trips", filters: [{ column: "route_id", op: "eq" as const, value: "R1" }], page: 3 };
    expect(initialView(tables("trips", "routes"), saved)).toEqual(saved);
  });

  it("ignores a restored view whose table the feed does not have", () => {
    const saved = { table: "pathways", filters: [], page: 1 };
    expect(initialView(tables("agency", "routes"), saved)?.table).toBe("agency");
  });

  it("drops the previous feed's filters when not restoring", () => {
    // Opening a different feed: its filters describe data that is no longer loaded.
    const stale = { table: "trips", filters: [{ column: "route_id", op: "eq" as const, value: "R1" }], page: 2 };
    const view = initialView(tables("feed_info", "trips"), null);
    expect(view?.table).toBe("feed_info");
    expect(view?.filters).toEqual([]);
    expect(stale.filters).toHaveLength(1); // the caller's object is untouched
  });
});
