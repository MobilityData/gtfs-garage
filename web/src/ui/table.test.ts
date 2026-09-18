import { describe, expect, it } from "vitest";

import type { RelatedLink } from "../sources/types";
import { describeRelated, type HighlightCallbacks, rowActions } from "./table";

/** What the server sends for a stop_id, taken from the real GTFS schema. */
const STOP_LINKS: RelatedLink[] = [
  { table: "stops", column: "parent_station" },
  { table: "stop_times", column: "stop_id" },
  { table: "transfers", column: "from_stop_id" },
  { table: "transfers", column: "to_stop_id" },
  { table: "pathways", column: "from_stop_id" },
  { table: "pathways", column: "to_stop_id" },
];

describe("describeRelated", () => {
  it("leaves a table that appears once labelled by name alone", () => {
    const labels = describeRelated(STOP_LINKS).map((b) => b.label);
    expect(labels).toContain("▸ stop_times");
    expect(labels).toContain("▸ stops");
  });

  /**
   * The defect this exists for: transfers and pathways each reference a stop
   * twice, so labelling by table alone produced pairs of buttons that looked
   * identical and navigated somewhere different.
   */
  it("names the column where a table appears more than once", () => {
    const labels = describeRelated(STOP_LINKS).map((b) => b.label);
    expect(labels).toContain("▸ transfers from_stop_id");
    expect(labels).toContain("▸ transfers to_stop_id");
    expect(labels).toContain("▸ pathways from_stop_id");
    expect(labels).toContain("▸ pathways to_stop_id");
  });

  it("gives every link a distinct label", () => {
    const labels = describeRelated(STOP_LINKS).map((b) => b.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("always names the column in the tooltip, ambiguous or not", () => {
    const buttons = describeRelated(STOP_LINKS);
    expect(buttons[0].title).toBe("Rows in stops whose parent_station is this");
    expect(buttons[2].title).toBe("Rows in transfers whose from_stop_id is this");
  });

  it("keeps each link's own table and column for the navigation", () => {
    // The label is cosmetic; the filter has to stay exact.
    const buttons = describeRelated(STOP_LINKS);
    expect(buttons.map((b) => b.link)).toEqual(STOP_LINKS);
  });

  it("handles a table with no reverse links", () => {
    expect(describeRelated([])).toEqual([]);
  });
});


/**
 * A viewer mounted without the map part has nothing to show a row on, and used
 * to draw 📍 and 🧭 on every row anyway - buttons that did nothing when
 * clicked. A callback's absence is what says so.
 */
describe("rowActions", () => {
  const ALL: HighlightCallbacks = {
    onHighlightStop: () => {},
    onHighlightShape: () => {},
    onHighlightRoute: () => {},
    onHighlightLocation: () => {},
  };
  const context = { table: "stops", hasRouteShapes: true };
  const labels = (
    values: Record<string, string | null>,
    callbacks: Partial<HighlightCallbacks> = ALL,
    ctx = context,
  ) => rowActions(values, ctx, callbacks).map((a) => a.label);

  it("offers nothing at all when there is no map", () => {
    expect(labels({ stop_id: "ST1", shape_id: "SH1", route_id: "R1" }, {})).toEqual([]);
  });

  it("offers a stop when something can show one", () => {
    expect(labels({ stop_id: "ST1" })).toEqual(["📍"]);
  });

  it("offers only what the row has ids for", () => {
    expect(labels({ shape_id: "SH1" })).toEqual(["🧭"]);
    expect(labels({})).toEqual([]);
  });

  it("drops just the one kind a host cannot show", () => {
    // Granular rather than one flag: a caller may support some and not others.
    const { onHighlightStop: _omitted, ...rest } = ALL;
    expect(labels({ stop_id: "ST1", shape_id: "SH1" }, rest)).toEqual(["🧭"]);
  });

  it("waits for a route's shapes before offering it", () => {
    // A route is drawn through its shape, so there is nothing to show until
    // the shape ids are known.
    expect(labels({ route_id: "R1" }, ALL, { table: "routes", hasRouteShapes: false })).toEqual([]);
    expect(labels({ route_id: "R1" }, ALL, { table: "routes", hasRouteShapes: true })).toEqual(["🚌"]);
  });

  it("treats a bare id as a zone only in the locations table", () => {
    expect(labels({ id: "zone-north" }, ALL, { table: "locations", hasRouteShapes: false })).toEqual(["🗺️"]);
    expect(labels({ id: "anything" }, ALL, { table: "areas", hasRouteShapes: false })).toEqual([]);
  });

  it("runs the callback the row was built for", () => {
    const seen: string[] = [];
    const actions = rowActions({ stop_id: "ST1" }, context, {
      ...ALL,
      onHighlightStop: (id) => seen.push(id),
    });
    actions[0].run();
    expect(seen).toEqual(["ST1"]);
  });
});
