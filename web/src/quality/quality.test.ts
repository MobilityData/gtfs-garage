/**
 * The Quality assistant's logic, against the validator's real output.
 *
 * The reports under src/gtfs_garage/data/demos/ were written by gtfs-validator 8.0.1
 * from feeds built to trigger as many notices as possible (see the README
 * there), so these tests run every guide and every fallback walkthrough over
 * samples the validator actually produces, not over samples imagined here.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import catalogJson from "../../../src/gtfs_garage/data/guides.json";
import type { TableInfo } from "../sources/types";
import { clock, contentTarget, distanceMetres, gtfsSeconds, tripLegs, type Call } from "./actions";
import { fallbackGuide, guideFor, type Catalog, type Guide } from "./catalog";
import { isLocated, locate, parseLines } from "./locate";
import { compareWithFeed, matches, parseReport, ReportError } from "./report";
import { fill, fillValue, UnfilledPlaceholder } from "./template";
import { placeCard } from "./tour";
import { resolveWalkthrough, CONTENT_ACTIONS } from "./walkthrough";
import { positionAt, schedule, MIN_LEG_MS, PAUSE_MS } from "../map/motion";
import { isMarked } from "../ui/table";

const catalog = catalogJson as unknown as Catalog;
const DATA = join(__dirname, "../../../src/gtfs_garage/data/demos");

/** The tables a feed directory has, as `/api/tables` would describe them, with exact lines. */
function tablesOf(feed: string): TableInfo[] {
  return readdirSync(join(DATA, feed))
    .filter((file) => file.endsWith(".txt"))
    .map((file) => {
      const header = readFileSync(join(DATA, feed, file), "utf-8").replace(/^﻿/, "").split(/\r?\n/)[0] ?? "";
      const table: TableInfo = {
        name: file.replace(/\.txt$/, ""),
        row_count: 1,
        lines: "exact" as const,
        forbidden: null,
        columns: header.split(",").map((name) => ({ name: name.trim(), related: [], enum_like: false })) as TableInfo["columns"],
      };
      return table;
    })
    .concat(
      // Zones are flattened to one row per feature, keyed by `id`, and have no lines.
      readdirSync(join(DATA, feed)).includes("locations.geojson")
        ? [{ name: "locations", row_count: 1, lines: null, forbidden: null, columns: [{ name: "id", related: [], enum_like: false }] as TableInfo["columns"] }]
        : [],
    );
}

const report = (feed: string) => parseReport(readFileSync(join(DATA, `${feed}.report.json`), "utf-8"));
const FEEDS = ["main", "future", "no-calendar", "parse-errors", "crash", "subfolder"];

describe("templates", () => {
  const sample = { stopId: "S1", geoDistanceToShape: 412.6, match: [45.5, -73.6], date: "20261016" };

  it("fills fields and formats them", () => {
    expect(fill("{{stopId}} is {{geoDistanceToShape|m}} away", sample)).toBe("S1 is 413 m away");
    expect(fill("{{date|date}}", sample)).toBe("2026-10-16");
  });

  it("hands a whole-placeholder argument its own value, not its text", () => {
    expect(fillValue({ point: "{{match}}" }, sample)).toEqual({ point: [45.5, -73.6] });
  });

  it("refuses a field the sample does not have, generically", () => {
    expect(() => fill("{{routeId}}", sample)).toThrow(UnfilledPlaceholder);
  });

  it("drops an unfillable item from a list instead of failing the list", () => {
    expect(fillValue(["{{stopId}}", "{{routeId}}"], sample)).toEqual(["S1"]);
  });
});

describe("locators", () => {
  const tables = tablesOf("main");

  it("prefers the line when the table's lines are exact", () => {
    const found = locate({ file: "stops.txt", line: "7", key: { stop_id: "S1" } }, tables);
    expect(isLocated(found) && found.filters).toEqual([{ column: "_line", op: "eq", value: "7" }]);
  });

  it("prefers the key when the lines are only approximate", () => {
    const approximate = tables.map((table) => (table.name === "stops" ? { ...table, lines: "approximate" as const } : table));
    const found = locate({ file: "stops", line: "7", key: { stop_id: "S1" } }, approximate);
    expect(isLocated(found) && found.filters).toEqual([{ column: "stop_id", op: "eq", value: "S1" }]);
  });

  it("widens a line to the rows around it", () => {
    const found = locate({ file: "stops", line: "3" }, tables, { around: 2 });
    expect(isLocated(found) && found.filters[0].value).toBe("2,3,4,5");
  });

  it("says why a file the feed lacks cannot be opened", () => {
    expect(locate({ file: "fare_rules_v9.txt", line: "2" }, tables)).toEqual({ problem: "This feed has no fare_rules_v9.txt." });
  });

  it("reads line lists however they arrive", () => {
    expect(parseLines("8, 4")).toEqual([4, 8]);
    expect(parseLines([12, 3])).toEqual([3, 12]);
    expect(parseLines("4 OR 1=1")).toBeNull();
  });
});

describe("reports", () => {
  it("rejects the HTML report with a sentence a reader can act on", () => {
    expect(() => parseReport("<html>")).toThrow(ReportError);
    expect(() => parseReport({ summary: {} })).toThrow(/report.json/);
  });

  it("accepts samples stored as a JSON string, as the Mobility Database keeps them", () => {
    const parsed = parseReport({ notices: [{ code: "x", severity: "ERROR", totalNotices: 2, sampleNotices: '[{"a":1}]' }] });
    expect(parsed.notices[0].sampleNotices).toEqual([{ a: 1 }]);
  });

  it("orders findings most severe first", () => {
    const severities = report("main").notices.map((notice) => notice.severity);
    expect(severities.indexOf("WARNING")).toBeGreaterThan(severities.lastIndexOf("ERROR"));
  });

  it("says when the report was made from a different feed", () => {
    const parsed = report("main");
    const tables = tablesOf("main").filter((table) => table.name !== "pathways");
    const comparison = compareWithFeed(parsed, tables);
    expect(matches(comparison)).toBe(false);
    expect(comparison.onlyInReport).toContain("pathways.txt");
  });
});

describe("every notice in the test reports gets a walkthrough", () => {
  for (const feed of FEEDS) {
    it(`resolves every sample in ${feed}`, () => {
      const tables = tablesOf(feed);
      for (const notice of report(feed).notices) {
        for (const sample of notice.sampleNotices) {
          const { guide, authored } = guideFor(catalog, notice.code, sample);
          const walkthrough = resolveWalkthrough(guide, authored, sample, tables);
          // At least the closing step, and never two content actions in one step.
          expect(walkthrough.steps.length, notice.code).toBeGreaterThanOrEqual(1);
          for (const step of walkthrough.steps) {
            expect(step.actions.filter((action) => CONTENT_ACTIONS.has(action.kind)).length, notice.code).toBeLessThanOrEqual(1);
          }
        }
      }
    });
  }

  it("points almost every finding in the main feed at rows or the map", () => {
    const tables = tablesOf("main");
    const pointless: string[] = [];
    for (const notice of report("main").notices) {
      const sample = notice.sampleNotices[0];
      const { guide, authored } = guideFor(catalog, notice.code, sample);
      const steps = resolveWalkthrough(guide, authored, sample, tables).steps;
      // The rows, the map, the calendar, or a card that shows the thing itself: a value, a file, a column.
      const shown = new Set(["calendar", "show_value", "show_files", "show_columns", "show_colors", "timeline", "show_record", "compare_records"]);
      const points = steps.some((step) =>
        step.actions.some((action) => action.kind.startsWith("map_") || contentTarget(step) !== null || shown.has(action.kind)),
      );
      if (!points) pointless.push(notice.code);
    }
    // Feed-level notices have nothing to point at; everything else should.
    expect(pointless).toEqual([]);
  });
  // Every written tour, on every demo feed: see tours.test.ts.
});

describe("fallback walkthroughs", () => {
  it("opens the row and outlines the field for a file-and-row notice", () => {
    const guide = fallbackGuide("missing_required_field", undefined, { filename: "stops.txt", csvRowNumber: 5, fieldName: "stop_name" });
    const walkthrough = resolveWalkthrough(guide, false, { filename: "stops.txt", csvRowNumber: 5, fieldName: "stop_name" }, tablesOf("main"));
    const target = contentTarget(walkthrough.steps[0]);
    expect(target?.view.table).toBe("stops");
    expect(target?.marks?.fields).toEqual(["stop_name"]);
  });

  it("draws two stops and the distance between them for a pair", () => {
    const sample = { stopId1: "A", stopId2: "B" };
    const kinds = fallbackGuide("x", undefined, sample).steps.flatMap((step) => step.actions?.map((action) => action.kind) ?? []);
    expect(kinds).toEqual(expect.arrayContaining(["map_focus", "map_measure"]));
  });
});

describe("distances", () => {
  it("measures great-circle distance", () => {
    // One thousandth of a degree of latitude is about 111 m anywhere.
    expect(Math.round(distanceMetres([-73.6, 45.5], [-73.6, 45.501]))).toBe(111);
  });
});

describe("trips in motion", () => {
  it("reads GTFS times past midnight and writes them back", () => {
    expect(gtfsSeconds("25:01:02")).toBe(90062);
    expect(gtfsSeconds("6:00:00")).toBe(21600);
    expect(gtfsSeconds("")).toBeNull();
    expect(clock(90062)).toBe("25:01:02");
  });

  it("measures a leg's speed the way the validator reports it", () => {
    // The main feed's fast leg: Hilltop to Pointe Est, 06:00:00 to 06:01:00.
    const sample = report("main").notices.find((notice) => notice.code === "fast_travel_between_consecutive_stops")!.sampleNotices[0];
    const calls: Call[] = [
      { stop: "S201", sequence: 1, arrival: 21600, departure: 21600, line: 50 },
      { stop: "S202", sequence: 2, arrival: 21660, departure: 21660, line: 51 },
    ];
    const [leg] = tripLegs(calls, [
      [-73.6, 45.52],
      [-73.446, 45.52],
    ]);
    expect(leg.kmh! / Number(sample.speedKph)).toBeCloseTo(1, 2);
  });

  it("keeps the pace of the times, with a floor and a fixed pause", () => {
    const at = (x: number): [number, number] => [x, 0];
    const path = [
      { at: at(0), time: 0, text: "a" },
      { at: at(1), time: 60, text: "b" },
      { at: at(1), time: 120, text: "b" }, // a dwell
      { at: at(2), time: 300, text: "c" },
      { at: at(3), time: 300, text: "d" }, // no time at all
    ];
    const plan = schedule({ path, duration: 4000 });
    const lengths = plan.legs.map((leg) => leg.end - leg.start);
    expect(lengths[0] * 3).toBeCloseTo(lengths[2]);
    expect(lengths[1]).toBeCloseTo(PAUSE_MS);
    expect(lengths[3]).toBe(MIN_LEG_MS);
    expect(positionAt(path, plan, lengths[0] / 2)).toEqual({ at: [0.5, 0], from: 0 });
  });
});

describe("the tour card", () => {
  const bounds = { left: 0, top: 0, width: 1200, height: 800 };
  const card = { width: 400, height: 200 };

  it("sits beside the map without covering the rows the step opened", () => {
    const rows = { left: 0, top: 60, width: 660, height: 200 };
    const map = { left: 670, top: 0, width: 530, height: 800 };
    const placed = placeCard(map, card, bounds, [rows, map]);
    expect(placed.side).toBe("left");
    expect(placed.top).toBeGreaterThanOrEqual(rows.top + rows.height);
  });

  it("points at rows from below them", () => {
    const rows = { left: 0, top: 60, width: 660, height: 90 };
    expect(placeCard(rows, card, bounds, [rows]).side).toBe("bottom");
  });

  it("goes in the middle when there is nothing to point at, and docks at the bottom when narrow", () => {
    expect(placeCard(null, card, bounds, [])).toMatchObject({ side: null, top: 300 });
    expect(placeCard({ left: 0, top: 0, width: 10, height: 10 }, card, { ...bounds, width: 500 }, [])).toMatchObject({ side: null, top: 592 });
  });
});

describe("marks", () => {
  const columns = ["trip_id", "stop_id"];
  it("marks every row, the named lines, or the rows with the named values", () => {
    expect(isMarked({ fields: [] }, columns, ["T", "S1"], 5)).toBe(true);
    expect(isMarked({ fields: [], lines: [5] }, columns, ["T", "S1"], 5)).toBe(true);
    expect(isMarked({ fields: [], lines: [5] }, columns, ["T", "S2"], 6)).toBe(false);
    expect(isMarked({ fields: [], key: [{ column: "stop_id", value: "S2" }] }, columns, ["T", "S2"], 6)).toBe(true);
  });

  it("marks only the notice's calls among the trip's", () => {
    // Written here rather than read from the catalog, which analysts edit.
    const notice = report("main").notices.find((entry) => entry.code === "fast_travel_between_consecutive_stops")!;
    const guide: Guide = {
      code: notice.code,
      locators: {
        trip_calls: { file: "stop_times", key: { trip_id: "{{tripId}}" } },
        calls: { file: "stop_times", line: "{{csvRowNumber1}},{{csvRowNumber2}}" },
      },
      steps: [
        {
          text: "Trip {{tripId}} leaves {{stopName1}} at {{departureTime1}}.",
          point: "map",
          actions: [
            { kind: "open_rows", at: "trip_calls", mark: "calls", highlight: ["arrival_time", "departure_time"] },
            { kind: "map_play", trip: "{{tripId}}", from: "{{stopId1}}", to: "{{stopId2}}", around: 2 },
          ],
        },
      ],
    };
    const walkthrough = resolveWalkthrough(guide, true, notice.sampleNotices[0], tablesOf("main"));
    expect(contentTarget(walkthrough.steps[0])?.marks).toMatchObject({ lines: [50, 51] });
    expect(walkthrough.steps[0].point).toBe("map");
  });
});

describe("the closing step", () => {
  it("says the first fix, or the rule, never a heading", () => {
    const sample = report("main").notices.find((entry) => entry.code === "stop_too_far_from_shape")!.sampleNotices[0];
    const { guide } = guideFor(catalog, "stop_too_far_from_shape", sample);
    const authored = resolveWalkthrough(guide, true, sample, tablesOf("main")).steps.at(-1)!;
    expect(authored.text).toBe(fill(catalog.notices.stop_too_far_from_shape.guide!.fix![0], sample));

    // No fix written: the rule in the validator's words, as its own step.
    const rule = catalog.notices.decreasing_or_equal_stop_time_distance;
    const row = { csvRowNumber: 5, tripId: "T1", stopSequence: 2 };
    const steps = resolveWalkthrough(fallbackGuide("decreasing_or_equal_stop_time_distance", rule, row), false, row, tablesOf("main"), rule).steps;
    expect(steps.at(-1)!.text).toBe(rule.description.split(/(?<=\.)\s/)[0]);
  });

  it("is not a step that repeats what the first one said", () => {
    // This rule has no description, and its summary already opens the walkthrough.
    const rule = catalog.notices.transfer_distance_too_large;
    const sample = report("main").notices.find((entry) => entry.code === "transfer_distance_too_large")!.sampleNotices[0];
    const steps = resolveWalkthrough(fallbackGuide("transfer_distance_too_large", rule, sample), false, sample, tablesOf("main"), rule).steps;
    expect(steps).toHaveLength(1);
    expect(steps[0].actions.map((action) => action.kind)).toContain("reference");
  });
});
