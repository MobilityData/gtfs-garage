import { describe, expect, it } from "vitest";

import type { NdjsonMessage } from "../ndjson";
import { coordinate, coordsFrom, createMapGeometry, MAX_MAP_VERTICES, stepFor } from "./geojson";
import type { Catalogue } from "./sql";

/**
 * A dataset that answers whatever it is asked, recording the SQL.
 *
 * The queries themselves are checked against DuckDB by
 * `scripts/integrations.sh conformance`, which asks this implementation and
 * `core/geojson.py` for the same four layers over the same feed and diffs every
 * coordinate. What is worth testing here is the arithmetic and the shaping
 * around them - and that the thinning the budget exists for is still in the SQL
 * at all, which a refactor can drop silently.
 */
function dataset(tables: Record<string, string[]>, answers: (sql: string) => Record<string, unknown>[]) {
  const asked: string[] = [];
  const catalogue: Catalogue = {
    columns: (table) => tables[table],
    file: (table) => `'${table}.parquet'`,
  };
  const run = async (sql: string) => {
    asked.push(sql);
    return answers(sql);
  };
  return { geometry: createMapGeometry(run, catalogue), asked };
}

const GTFS = {
  stops: ["stop_id", "stop_name", "stop_lat", "stop_lon"],
  shapes: ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"],
  routes: ["route_id", "route_short_name", "route_long_name", "route_color", "route_type"],
  trips: ["route_id", "trip_id", "shape_id"],
};

describe("stepFor", () => {
  it("leaves a feed inside the budget untouched", () => {
    expect(stepFor(0)).toBe(1);
    expect(stepFor(MAX_MAP_VERTICES)).toBe(1);
  });

  it("reduces a feed twice as large twice as hard", () => {
    expect(stepFor(MAX_MAP_VERTICES * 2)).toBe(2);
    expect(stepFor(MAX_MAP_VERTICES * 10)).toBe(10);
  });

  it("rounds up, so the budget is a ceiling rather than a target", () => {
    expect(stepFor(MAX_MAP_VERTICES + 1)).toBe(2);
  });
});

describe("coordinate", () => {
  it("reads a number the feed states", () => {
    expect(coordinate("45.5")).toBe(45.5);
    expect(coordinate(0)).toBe(0);
  });

  /**
   * GTFS leaves these blank for a stop inside a station, and `Number("")` is
   * 0 - which would place every such stop in the Gulf of Guinea. The server
   * has always read a blank as absent; this is where the two agree.
   */
  it("reads a blank as no position rather than as zero", () => {
    expect(coordinate("")).toBeNull();
    expect(coordinate(null)).toBeNull();
    expect(coordinate(undefined)).toBeNull();
  });

  it("reads something unparseable as no position", () => {
    expect(coordinate("north a bit")).toBeNull();
  });
});

describe("coordsFrom", () => {
  it("reads the coordinates the query built", () => {
    expect(coordsFrom("[[1,2],[3,4]]", 1)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  /**
   * The step filter keeps every step-th point and the last one; the server
   * appends that last point only when it differs from the one already kept.
   * A line whose final point repeats is where the two would disagree.
   */
  it("drops a closing point that repeats the one before it", () => {
    expect(coordsFrom("[[1,1],[2,2],[2,2]]", 3)).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it("keeps a repeated point when nothing was thinned", () => {
    expect(coordsFrom("[[1,1],[2,2],[2,2]]", 1)).toHaveLength(3);
  });

  it("is empty rather than broken when the text will not parse", () => {
    expect(coordsFrom("not json", 1)).toEqual([]);
  });
});

describe("the stops layer", () => {
  it("carries only what the map reads", async () => {
    const { geometry } = dataset(GTFS, () => [
      { stop_id: "S1", stop_name: "Central", stop_lat: "45.5", stop_lon: "-73.6" },
    ]);
    const collection = await geometry.collection("stops");
    expect(collection.features).toEqual([
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-73.6, 45.5] },
        properties: { stop_id: "S1", stop_name: "Central" },
      },
    ]);
  });

  it("leaves out a stop the feed gives no position", async () => {
    const { geometry } = dataset(GTFS, () => [
      { stop_id: "S1", stop_name: "Central", stop_lat: null, stop_lon: null },
      { stop_id: "S2", stop_name: "Depot", stop_lat: "", stop_lon: "" },
      { stop_id: "S3", stop_name: "Yard", stop_lat: "45.5", stop_lon: "-73.6" },
    ]);
    const collection = await geometry.collection("stops");
    expect(collection.features.map((feature) => feature.properties.stop_id)).toEqual(["S3"]);
  });

  it("rounds to about ten centimetres, like the server", async () => {
    const { geometry } = dataset(GTFS, () => [
      { stop_id: "S1", stop_name: "", stop_lat: "45.1234567", stop_lon: "-73.7654321" },
    ]);
    const [feature] = (await geometry.collection("stops")).features;
    expect(feature.geometry).toEqual({ type: "Point", coordinates: [-73.76543, 45.12346] });
  });

  it("is empty for a dataset with no stops file", async () => {
    const { geometry } = dataset({ trips: GTFS.trips }, () => []);
    expect((await geometry.collection("stops")).features).toEqual([]);
  });
});

describe("the routes layer", () => {
  const answers = (sql: string) => {
    if (sql.includes("DISTINCT ON")) {
      return [
        { shape_id: "SH1", route_id: "10", route_short_name: "10", route_long_name: "Riverside", route_color: "", route_type: "3" },
      ];
    }
    if (sql.includes("string_agg")) return [{ shape_id: "SH1", coords: "[[1,1],[2,2]]" }];
    return [{ n: 10n }];
  };

  it("draws each route with the shape its trips name, coloured and typed", async () => {
    const { geometry } = dataset(GTFS, answers);
    const [feature] = (await geometry.collection("routes")).features;
    expect(feature.properties).toEqual({
      shape_id: "SH1",
      route_id: "10",
      route_short_name: "10",
      route_long_name: "Riverside",
      // The feed states none, and a line with no colour is invisible against
      // the basemap rather than default-coloured.
      route_color: "3388ff",
      // The map styles width and opacity on this.
      route_type: "3",
    });
    expect(feature.geometry).toEqual({ type: "LineString", coordinates: [[1, 1], [2, 2]] });
  });

  it("picks the route's shape deterministically, as the server does", async () => {
    const { geometry, asked } = dataset(GTFS, answers);
    await geometry.collection("routes");
    const distinct = asked.find((sql) => sql.includes("DISTINCT ON"))!;
    expect(distinct).toContain("ORDER BY r.route_id, t.shape_id");
  });

  it("names a column the feed does not have as empty rather than querying it", async () => {
    const { geometry, asked } = dataset(
      { ...GTFS, routes: ["route_id"] },
      (sql) => (sql.includes("DISTINCT ON") ? [] : [{ n: 1n }]),
    );
    await geometry.collection("routes");
    const distinct = asked.find((sql) => sql.includes("DISTINCT ON"))!;
    expect(distinct).toContain("'' AS route_color");
    expect(distinct).not.toContain('r."route_color"');
  });
});

describe("the shapes layer", () => {
  it("leaves out the shapes the routes layer already draws", async () => {
    const { geometry, asked } = dataset(GTFS, (sql) => {
      if (sql.includes("DISTINCT ON")) return [{ shape_id: "SH1", route_id: "10" }];
      if (sql.includes("string_agg")) return [{ shape_id: "SH2", coords: "[[1,1],[2,2]]" }];
      return [{ n: 1n }];
    });
    await geometry.collection("shapes");
    expect(asked.find((sql) => sql.includes("string_agg"))).toContain("NOT IN");
  });

  it("thins against the budget, which is what keeps a national feed openable", async () => {
    const { geometry, asked } = dataset(GTFS, (sql) => {
      if (sql.includes("COUNT(*) AS n")) return [{ n: BigInt(MAX_MAP_VERTICES * 4) }];
      if (sql.includes("DISTINCT ON")) return [];
      return [{ shape_id: "SH1", coords: "[[1,1],[2,2]]" }];
    });
    await geometry.collection("shapes");
    const query = asked.find((sql) => sql.includes("string_agg"))!;
    expect(query).toContain("(rn - 1) % 4 = 0 OR rn = n");
  });

  it("draws a named handful whole, since a highlight is not a layer", async () => {
    const { geometry, asked } = dataset(GTFS, (sql) =>
      sql.includes("string_agg") ? [{ shape_id: "SH1", coords: "[[1,1],[2,2]]" }] : [{ n: BigInt(MAX_MAP_VERTICES * 4) }],
    );
    await geometry.collection("shapes", ["SH1"]);
    const query = asked.find((sql) => sql.includes("string_agg"))!;
    expect(query).toContain("(rn - 1) % 1 = 0");
    expect(query).toContain("shape_id IN ('SH1')");
  });

  it("escapes an id the way every other query does", async () => {
    const { geometry, asked } = dataset(GTFS, () => []);
    await geometry.collection("shapes", ["it's"]);
    expect(asked.find((sql) => sql.includes("string_agg"))).toContain("'it''s'");
  });

  it("drops a line left with fewer than two points", async () => {
    const { geometry } = dataset(GTFS, (sql) =>
      sql.includes("string_agg")
        ? [{ shape_id: "SH1", coords: "[[1,1]]" }, { shape_id: "SH2", coords: "[[1,1],[2,2]]" }]
        : [{ n: 1n }],
    );
    const collection = await geometry.collection("shapes", ["SH1", "SH2"]);
    expect(collection.features.map((feature) => feature.properties.shape_id)).toEqual(["SH2"]);
  });
});

describe("the zones layer", () => {
  it("keeps the polygon the feed drew rather than rebuilding it", async () => {
    const polygon = '{"type":"Polygon","coordinates":[[[-119,34.4],[-119,34.5],[-118.9,34.4],[-119,34.4]]]}';
    const { geometry } = dataset({ locations: ["id", "stop_name", "geometry"] }, () => [
      { id: "area_1", stop_name: "Riverside zone", geometry: polygon },
    ]);
    const [feature] = (await geometry.collection("locations")).features;
    expect(feature.geometry).toEqual(JSON.parse(polygon));
    expect(feature.properties).toEqual({ location_id: "area_1", stop_name: "Riverside zone" });
  });

  it("skips a zone whose geometry will not parse", async () => {
    const { geometry } = dataset({ locations: ["id", "stop_name", "geometry"] }, () => [
      { id: "bad", stop_name: "", geometry: "{" },
      { id: "worse", stop_name: "", geometry: '{"type":"Polygon"}' },
    ]);
    expect((await geometry.collection("locations")).features).toEqual([]);
  });
});

describe("streaming a layer", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      stop_id: `S${index}`,
      stop_name: "",
      stop_lat: "45.5",
      stop_lon: "-73.6",
    }));

  it("announces the real total before the first batch", async () => {
    const { geometry } = dataset(GTFS, () => many(3));
    const seen: NdjsonMessage[] = [];
    await geometry.stream("stops", (message) => seen.push(message));

    expect(seen[0]).toEqual({ type: "header", total: 3, step: 1 });
    expect(seen).toHaveLength(2);
  });

  it("hands the features over in batches, so the map paints as it goes", async () => {
    const { geometry } = dataset(GTFS, () => many(12_000));
    const batches: number[] = [];
    await geometry.stream("stops", (message) => {
      if (message.type === "batch") batches.push(message.features.length);
    });
    expect(batches).toEqual([5000, 5000, 2000]);
  });

  it("tells the map how hard the lines were thinned", async () => {
    const { geometry } = dataset(GTFS, (sql) => {
      if (sql.includes("COUNT(*) AS n")) return [{ n: BigInt(MAX_MAP_VERTICES * 3) }];
      return [];
    });
    const seen: NdjsonMessage[] = [];
    await geometry.stream("shapes", (message) => seen.push(message));
    expect(seen[0]).toEqual({ type: "header", total: 0, step: 3 });
  });

  it("abandons a layer whose feed has been replaced", async () => {
    const { geometry } = dataset(GTFS, () => many(3));
    const controller = new AbortController();
    controller.abort();

    // The name the map checks for: an abandoned layer is a feed that changed,
    // not a failure to report.
    await expect(
      geometry.stream("stops", () => {}, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("is an empty layer, not a failure, when the query cannot run", async () => {
    const { geometry } = dataset(GTFS, () => {
      throw new Error("no such file");
    });
    const seen: NdjsonMessage[] = [];
    await geometry.stream("stops", (message) => seen.push(message));
    expect(seen).toEqual([{ type: "header", total: 0, step: 1 }]);
  });
});
