/**
 * The map's geometry, built in the browser.
 *
 * The twin of `core/geojson.py`, the way `explore/sql.ts` is the twin of the
 * derived views: same layers, same thinning, same properties, assembled from
 * Parquet by DuckDB-WASM instead of from DuckDB by a server. It is what makes
 * the static deployment - a bucket of `{table}.parquet` and a manifest, with no
 * server of ours anywhere - show a map rather than degrade to tables.
 *
 * One difference, and it is in where the work happens. The Python side streams
 * `shapes.txt` row by row and thins in Python, because the rows are already in
 * the same process. Here the rows are in a worker behind range requests, so
 * **the thinning is done in SQL** and one row per shape crosses the boundary
 * carrying its coordinates as text. On a national feed that is the difference
 * between ten million rows reaching JavaScript and sixty thousand: DuckDB does
 * the pass it is built for, and the budget below decides what survives it.
 *
 * The emitting is still batched, so the map paints as the layer arrives and a
 * reader sees routes within a second of a feed opening. The query itself is not
 * incremental - DuckDB-WASM answers a statement whole - so the first batch waits
 * on the aggregation rather than on the first row.
 */

import type { FeatureCollection, GeoFeature, GeoJsonKind } from "../types";
import type { NdjsonMessage } from "../ndjson";
import { has, literal, type Catalogue } from "./sql";
import type { Run } from "./index";

/**
 * Most shape vertices the map may hold in total, a vertex being one row of
 * `shapes.txt`. Mirrors `MAX_MAP_VERTICES` in `core/geojson.py`, and must stay
 * mirrored: it is the ceiling a browser survives rather than a preference, and
 * this implementation draws into the same heap the other one does.
 */
export const MAX_MAP_VERTICES = 600_000;

/** About 10 cm, and most of the payload on a dense feed. Mirrors the server. */
export const COORD_PRECISION = 5;

/** Large enough that per-batch overhead disappears, small enough to redraw. */
export const BATCH_SIZE = 5000;

/**
 * How many points to advance between kept vertices, for the whole map.
 *
 * One budget for the map rather than one per layer: the routes and shapes
 * layers are both drawn from `shapes.txt` into the same heap, so budgeting them
 * separately quietly allows twice the number. Mirrors `vertex_step`.
 */
export function stepFor(vertices: number): number {
  return Math.max(1, Math.ceil(vertices / MAX_MAP_VERTICES));
}

/**
 * A shape's coordinates, as the thinned SQL produced them.
 *
 * The step filter keeps every `step`-th point and the last one, so a line still
 * ends where it ends. The server appends that last point only when it differs
 * from the one already kept; a filter cannot express "unless it is a duplicate",
 * so the duplicate is dropped here instead. Without this the two implementations
 * disagree on exactly the shapes whose final point repeats - which is a real
 * shape of feed, not a hypothetical one.
 */
export function coordsFrom(json: string, step: number): [number, number][] {
  let coords: [number, number][];
  try {
    coords = JSON.parse(json) as [number, number][];
  } catch {
    return [];
  }
  if (step > 1 && coords.length > 1) {
    const last = coords[coords.length - 1];
    const previous = coords[coords.length - 2];
    if (last[0] === previous[0] && last[1] === previous[1]) coords.pop();
  }
  return coords;
}

function num(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/** A latitude or longitude the feed states, or null where it states none. */
export function coordinate(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function idList(ids: string[]): string {
  return ids.map(literal).join(", ");
}

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/**
 * Everything but `route_id` is optional in GTFS, and naming a column a feed
 * does not have takes the whole routes layer down with it - silently, since
 * these builders fall back to an empty collection. Mirrors the server's list.
 */
const OPTIONAL_ROUTE_COLUMNS = ["route_short_name", "route_long_name", "route_color", "route_type"];

export interface MapGeometry {
  /** One collection, for the id-filtered highlight requests. */
  collection(kind: GeoJsonKind, ids?: string[]): Promise<FeatureCollection>;
  /** A header then batches, for a whole layer. Mirrors the NDJSON stream. */
  stream(
    kind: GeoJsonKind,
    onMessage: (message: NdjsonMessage) => void,
    signal?: AbortSignal,
  ): Promise<void>;
}

export function createMapGeometry(run: Run, catalogue: Catalogue): MapGeometry {
  /** A layer a dataset has no table for is empty, not an error. See the server. */
  const missing = (table: string) => catalogue.columns(table) === undefined;

  const aborted = (): Error => {
    const error = new Error("The map layer was abandoned.");
    // The name the map checks for: an abandoned layer is not a failure, it is
    // a feed that was replaced while this one was still drawing.
    error.name = "AbortError";
    return error;
  };

  /**
   * The feed's thinning step, from its own `shapes.txt` row count.
   *
   * No feed is special-cased: one twice as large is reduced twice as hard, and
   * there is no threshold to retune as feeds grow.
   */
  const vertexStep = async (): Promise<number> => {
    if (missing("shapes")) return 1;
    try {
      const rows = await run(`SELECT COUNT(*) AS n FROM ${catalogue.file("shapes")}`);
      return stepFor(num(rows[0]?.n));
    } catch {
      return 1;
    }
  };

  const round = (value: number): number => Number(value.toFixed(COORD_PRECISION));

  const stops = async (ids?: string[]): Promise<GeoFeature[]> => {
    if (missing("stops")) return [];
    const where = ids?.length ? `WHERE stop_id IN (${idList(ids)})` : "";
    const rows = await run(`
      SELECT stop_id, stop_name, stop_lat, stop_lon
      FROM ${catalogue.file("stops")} ${where}
    `);

    const features: GeoFeature[] = [];
    for (const row of rows) {
      // An empty string is a stop with no position, not a stop at zero: GTFS
      // leaves the columns blank for a stop inside a station, and `Number("")`
      // is 0, which would put it in the Gulf of Guinea. Mirrors `_to_float`.
      const lat = coordinate(row.stop_lat);
      const lon = coordinate(row.stop_lon);
      if (lat === null || lon === null) continue;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [round(lon), round(lat)] },
        // Only what the map reads: the popup shows these two and the layer
        // styles on neither. On a feed with half a million stops, a property
        // nobody looks at is tens of megabytes of browser memory.
        properties: { stop_id: text(row.stop_id), stop_name: text(row.stop_name) },
      });
    }
    return features;
  };

  /**
   * One representative shape per route: the first shape any of its trips uses.
   *
   * `DISTINCT ON` collapses the trips join before anything touches the geometry,
   * and the ordering is what makes "first" mean something - without it, which
   * shape a route is drawn with changes between runs. Mirrors
   * `_route_shapes_sql`, ordering included.
   */
  const routeShapesSql = (): string => {
    const selected = OPTIONAL_ROUTE_COLUMNS.map((name) =>
      has(catalogue, "routes", name)
        ? `COALESCE(r."${name}", '') AS ${name}`
        : `'' AS ${name}`,
    ).join(",\n             ");

    return `
      SELECT DISTINCT ON (r.route_id)
             t.shape_id AS shape_id,
             r.route_id,
             ${selected}
      FROM ${catalogue.file("routes")} r
      JOIN ${catalogue.file("trips")} t ON t.route_id = r.route_id
      WHERE t.shape_id IS NOT NULL AND t.shape_id != ''
      ORDER BY r.route_id, t.shape_id
    `;
  };

  /**
   * Shapes as one row each, thinned, in shape_id order.
   *
   * The window functions are the thinning: `rn` numbers a shape's usable points
   * and `n` counts them, so "every step-th point, plus the last" is a filter and
   * never a second pass. Points the feed states unreadably are dropped before
   * either is computed, so a shape with one good point and three broken ones is
   * the single-point shape it really is rather than a line.
   */
  const shapeRowsSql = (step: number, where: string): string => `
    WITH points AS (
      SELECT shape_id,
             TRY_CAST(shape_pt_lat AS DOUBLE) AS lat,
             TRY_CAST(shape_pt_lon AS DOUBLE) AS lon,
             TRY_CAST(shape_pt_sequence AS BIGINT) AS seq
      FROM ${catalogue.file("shapes")}
      ${where}
    ),
    usable AS (
      SELECT shape_id, lat, lon,
             row_number() OVER (PARTITION BY shape_id ORDER BY seq) AS rn,
             COUNT(*) OVER (PARTITION BY shape_id) AS n
      FROM points
      WHERE lat IS NOT NULL AND lon IS NOT NULL
    )
    SELECT shape_id,
           '[' || string_agg(
             '[' || round(lon, ${COORD_PRECISION}) || ',' || round(lat, ${COORD_PRECISION}) || ']',
             ',' ORDER BY rn
           ) || ']' AS coords
    FROM usable
    WHERE n >= 2 AND ((rn - 1) % ${step} = 0 OR rn = n)
    GROUP BY shape_id
    ORDER BY shape_id
  `;

  const shapeFeatures = async (
    step: number,
    where: string,
    properties: (shapeId: string) => Record<string, string> | null,
  ): Promise<GeoFeature[]> => {
    if (missing("shapes")) return [];
    const rows = await run(shapeRowsSql(step, where));

    const features: GeoFeature[] = [];
    for (const row of rows) {
      const shapeId = text(row.shape_id);
      const own = properties(shapeId);
      if (!own) continue;
      const coordinates = coordsFrom(text(row.coords), step);
      if (coordinates.length < 2) continue;
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates },
        properties: own,
      });
    }
    return features;
  };

  /** Which shape each route is drawn with, and what to label it. */
  const routeShapes = async (): Promise<Map<string, Record<string, string>>> => {
    if (missing("routes") || missing("trips")) return new Map();
    const rows = await run(routeShapesSql());

    // Keyed by shape_id, later rows winning: two routes sharing a shape are one
    // line on the map, and this is which of them it is labelled as. The server
    // builds the same dictionary the same way round.
    const byShape = new Map<string, Record<string, string>>();
    for (const row of rows) {
      byShape.set(text(row.shape_id), {
        shape_id: text(row.shape_id),
        route_id: text(row.route_id),
        route_short_name: text(row.route_short_name),
        route_long_name: text(row.route_long_name),
        route_color: text(row.route_color) || "3388ff",
        // The map styles line width and opacity on this; without it every route
        // silently draws at the default width.
        route_type: text(row.route_type),
      });
    }
    return byShape;
  };

  const routes = async (step: number): Promise<GeoFeature[]> => {
    const byShape = await routeShapes();
    if (!byShape.size) return [];
    const where = `WHERE shape_id IN (${idList([...byShape.keys()])})`;
    return shapeFeatures(step, where, (shapeId) => byShape.get(shapeId) ?? null);
  };

  /**
   * Shapes no route already draws.
   *
   * The exclusion happens here rather than on the map: a route's shape in both
   * layers is the same geometry parsed twice before one copy is thrown away.
   */
  const shapes = async (step: number, ids?: string[]): Promise<GeoFeature[]> => {
    if (ids?.length) {
      // A highlight names its shapes, and asks for them whole: it is a handful
      // of lines, and thinning one route's geometry to a national budget would
      // draw the one thing a reader is looking at as a dozen points.
      const where = `WHERE shape_id IN (${idList(ids)})`;
      return shapeFeatures(1, where, (shapeId) => ({ shape_id: shapeId }));
    }
    const byShape = await routeShapes();
    const where = byShape.size
      ? `WHERE shape_id NOT IN (${idList([...byShape.keys()])})`
      : "";
    return shapeFeatures(step, where, (shapeId) => ({ shape_id: shapeId }));
  };

  /**
   * GTFS-Flex zones. Never thinned: a feed carries tens to hundreds of them at
   * a few hundred vertices each, which is nothing beside what the budget exists
   * for. The geometry is the GeoJSON the feed contained, so it is parsed rather
   * than rebuilt - a zone is whatever polygon the producer drew.
   */
  const locations = async (ids?: string[]): Promise<GeoFeature[]> => {
    if (missing("locations")) return [];
    const where = ids?.length ? `AND id IN (${idList(ids)})` : "";
    const rows = await run(`
      SELECT id, stop_name, geometry
      FROM ${catalogue.file("locations")}
      WHERE geometry IS NOT NULL ${where}
    `);

    const features: GeoFeature[] = [];
    for (const row of rows) {
      let shape: { type?: string; coordinates?: unknown } | null = null;
      try {
        shape = JSON.parse(text(row.geometry)) as { type?: string; coordinates?: unknown };
      } catch {
        continue;
      }
      if (!shape || typeof shape !== "object" || shape.coordinates === undefined) continue;
      features.push({
        type: "Feature",
        geometry: shape as GeoFeature["geometry"],
        properties: { location_id: text(row.id), stop_name: text(row.stop_name) },
      });
    }
    return features;
  };

  /** Every feature of one layer, which the stream then hands over in batches. */
  const build = async (kind: GeoJsonKind, step: number, ids?: string[]): Promise<GeoFeature[]> => {
    if (kind === "stops") return stops(ids);
    if (kind === "locations") return locations(ids);
    if (kind === "routes") return routes(step);
    return shapes(step, ids);
  };

  return {
    async collection(kind: GeoJsonKind, ids?: string[]): Promise<FeatureCollection> {
      try {
        // A whole layer asked for as one collection is thinned like the stream;
        // a named handful is not. See `shapes`.
        const step = ids?.length ? 1 : await vertexStep();
        return { type: "FeatureCollection", features: await build(kind, step, ids) };
      } catch {
        // An empty layer rather than a broken map: the server's builders do the
        // same, and a feed missing a file is the ordinary reason to get here.
        return EMPTY;
      }
    },

    async stream(kind, onMessage, signal): Promise<void> {
      if (signal?.aborted) throw aborted();
      const step = kind === "stops" || kind === "locations" ? 1 : await vertexStep();

      let features: GeoFeature[] = [];
      try {
        features = await build(kind, step);
      } catch {
        features = [];
      }
      if (signal?.aborted) throw aborted();

      // The real count, not an estimate: the features exist before the header
      // does, so the progress line cannot promise a total it never reaches.
      onMessage({ type: "header", total: features.length, step });

      for (let at = 0; at < features.length; at += BATCH_SIZE) {
        if (signal?.aborted) throw aborted();
        onMessage({ type: "batch", features: features.slice(at, at + BATCH_SIZE) });
        // Back to the event loop between batches, so the map actually paints
        // what it was just given instead of after the last one.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}
