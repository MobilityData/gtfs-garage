import { describe, expect, it } from "vitest";

import { Navigator } from "./navigation";

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
