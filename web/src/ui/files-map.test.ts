import { describe, expect, it } from "vitest";

import type { PageResponse } from "../sources/types";
import { selectionFromFilters, selectionFromRows } from "./files-map";

describe("selectionFromFilters", () => {
  it("selects what a view pins with is or is one of", () => {
    expect(
      selectionFromFilters([
        { column: "route_id", op: "eq", value: "2" },
        { column: "stop_id", op: "in", value: "65, 54,,65" },
      ]),
    ).toEqual({ routeIds: ["2"], shapeIds: [], stopIds: ["65", "54"] });
  });

  it("reads the column name, whichever file the view is of", () => {
    expect(selectionFromFilters([{ column: "shape_id", op: "eq", value: "2_236" }])).toEqual({
      routeIds: [],
      shapeIds: ["2_236"],
      stopIds: [],
    });
  });

  it("selects nothing from filters that narrow rows without naming a thing to draw", () => {
    expect(selectionFromFilters([])).toBeNull();
    expect(selectionFromFilters([{ column: "route_id", op: "ne", value: "2" }])).toBeNull();
    expect(selectionFromFilters([{ column: "route_id", op: "contains", value: "2" }])).toBeNull();
    expect(selectionFromFilters([{ column: "service_id", op: "eq", value: "WKDY" }])).toBeNull();
    expect(selectionFromFilters([{ column: "route_id", op: "eq", value: "" }])).toBeNull();
  });
});

describe("selectionFromRows", () => {
  const page = (columns: string[], rows: (string | null)[][]): PageResponse =>
    ({ columns, rows, total: rows.length, page: 1, page_size: 500 }) as PageResponse;

  it("selects the routes a filter on routes.txt leaves", () => {
    // route_type = 0: OC Transpo's three light rail lines.
    const rows = page(["route_id", "route_type"], [["1-373", "0"], ["2-354", "0"], ["4-354", "0"]]);
    expect(selectionFromRows(rows)).toEqual({ routeIds: ["1-373", "2-354", "4-354"], shapeIds: [], stopIds: [] });
  });

  it("reads every drawable column the rows carry, once each", () => {
    const rows = page(
      ["trip_id", "route_id", "shape_id"],
      [
        ["t1", "82", "shp-82-05"],
        ["t2", "82", "shp-82-51"],
        ["t3", "82", null],
      ],
    );
    expect(selectionFromRows(rows)).toEqual({ routeIds: ["82"], shapeIds: ["shp-82-05", "shp-82-51"], stopIds: [] });
  });

  it("selects nothing from rows that reference nothing drawable", () => {
    expect(selectionFromRows(page(["service_id", "monday"], [["WKDY", "1"]]))).toBeNull();
    expect(selectionFromRows(page(["route_id"], []))).toBeNull();
  });
});
