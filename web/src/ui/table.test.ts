import { describe, expect, it } from "vitest";

import type { RelatedLink } from "../sources/types";
import { describeRelated } from "./table";

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
