/**
 * The feed's own layers, and how they are combined with a basemap.
 *
 * Sources and layers are declared up front rather than added in a `load`
 * handler: `load` only fires after the first paint, so in a background tab
 * (where requestAnimationFrame never runs) the layers would never exist and the
 * feed's data would silently never reach the map.
 *
 * Route colouring follows the conventions used by mobilitydatabase.org - colour
 * from `route_color`, width by `route_type`, a white casing underneath - so the
 * two read alike. The geometry itself is generated locally from the feed's own
 * shapes.txt; nothing here depends on that service.
 */

import type { BasemapSpec } from "./basemap";

export const EMPTY_FEATURE_COLLECTION = {
  type: "FeatureCollection" as const,
  features: [],
};

const geojsonSource = () => ({ type: "geojson", data: EMPTY_FEATURE_COLLECTION });

/**
 * How stops are drawn, and how they are drawn when they are the subject.
 *
 * Scaled by zoom rather than hidden at low zoom: an inspection tool has to
 * show where the stops are before you know where to zoom. The focused pair is
 * exported beside the ordinary one so the map can swap between them without a
 * second copy of either drifting out of step.
 */
export const STOP_RADIUS = ["interpolate", ["linear"], ["zoom"], 6, 1.5, 12, 3, 16, 5];
export const STOP_OPACITY = 0.45;
export const STOP_RADIUS_FOCUSED = ["interpolate", ["linear"], ["zoom"], 6, 3, 12, 5, 16, 7];
export const STOP_OPACITY_FOCUSED = 0.95;

/**
 * How routes are drawn: across the network, and when they are the subject.
 *
 * Thin across the network, where two hundred routes have to share the map.
 * Picked out on their own - a filtered list, a route's card - the same widths
 * left a bus route a 1px line inside its white casing, which read as a white
 * road rather than a route. Exported in pairs so the map swaps between them
 * the way it swaps the stops'.
 */
export const ROUTE_WIDTH = ["match", ["get", "route_type"], "3", 1, "1", 4, 3];
export const ROUTE_WIDTH_FOCUSED = ["match", ["get", "route_type"], "3", 3.5, "1", 5, 4];
export const ROUTE_CASING_WIDTH = ["match", ["get", "route_type"], "3", 5, "1", 10, 7];
export const ROUTE_CASING_WIDTH_FOCUSED = ["match", ["get", "route_type"], "3", 6, "1", 9, 7];
export const ROUTE_OPACITY = ["match", ["get", "route_type"], "1", 0.8, "3", 0.6, 0.7];
export const ROUTE_OPACITY_FOCUSED = 0.95;

/**
 * What a route whose own colour is too pale to see is drawn in.
 *
 * GTFS defaults `route_color` to white, and a white line inside a white casing
 * is no line at all - which is how route 84 vanished from a filtered map.
 */
export const PALE_ROUTE_COLOR = "#6b7280";

/** A route's colour as the map draws it: its own, unless too pale to see. Mirrors `routeLineColor`. */
const ROUTE_COLOR = [
  "let",
  "rgba",
  ["to-rgba", ["to-color", ["concat", "#", ["get", "route_color"]], "#3388ff"]],
  [
    "case",
    [
      ">",
      [
        "+",
        ["*", 0.2126, ["at", 0, ["var", "rgba"]]],
        ["*", 0.7152, ["at", 1, ["var", "rgba"]]],
        ["*", 0.0722, ["at", 2, ["var", "rgba"]]],
      ],
      0.85 * 255,
    ],
    PALE_ROUTE_COLOR,
    ["to-color", ["concat", "#", ["get", "route_color"]], "#3388ff"],
  ],
];

/** What the highlight is drawn in when the thing highlighted has no colour of its own. */
export const HIGHLIGHT_COLOR = "#ff0066";

/**
 * A route's `route_color` as a line colour for its highlight, or null to keep
 * the highlight's own.
 *
 * Null for a colour the feed leaves empty or states unreadably, and for one too
 * pale to see against a light basemap: GTFS defaults `route_color` to white,
 * and a focused route drawn in white is a route that has vanished.
 */
export function routeLineColor(raw: unknown): string | null {
  const hex = typeof raw === "string" ? raw.trim().replace(/^#/, "") : "";
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.85 ? null : `#${hex}`;
}

export const SOURCE_IDS = ["locations", "routes", "shapes", "stops", "highlight"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

type StyleSpec = Record<string, unknown> & {
  sources: Record<string, unknown>;
  layers: Record<string, unknown>[];
};

function feedSources(): Record<string, unknown> {
  return Object.fromEntries(SOURCE_IDS.map((id) => [id, geojsonSource()]));
}

function feedLayers(): Record<string, unknown>[] {
  return [
    // Zones first, so they sit under the lines. A zone is an area a rider can
    // be picked up in, not a thing drawn on top of the network.
    {
      id: "locations-fill",
      type: "fill",
      source: "locations",
      paint: { "fill-color": "#7c3aed", "fill-opacity": 0.12 },
    },
    {
      id: "locations-outline",
      type: "line",
      source: "locations",
      paint: { "line-color": "#7c3aed", "line-width": 1, "line-opacity": 0.5 },
    },
    // Shapes no route claims (feeds whose trips.txt has no shape_id) still need
    // drawing, otherwise those feeds render an empty map.
    {
      id: "shapes",
      type: "line",
      source: "shapes",
      paint: { "line-color": "#9ca3af", "line-width": 1.5, "line-opacity": 0.6 },
    },
    {
      id: "routes-white",
      type: "line",
      source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#ffffff",
        "line-width": ROUTE_CASING_WIDTH,
        "line-opacity": 0.8,
      },
    },
    {
      id: "routes",
      type: "line",
      source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ROUTE_COLOR,
        "line-width": ROUTE_WIDTH,
        "line-opacity": ROUTE_OPACITY,
      },
    },
    {
      id: "stops",
      type: "circle",
      source: "stops",
      paint: {
        "circle-radius": STOP_RADIUS,
        "circle-color": "#1c1e21",
        "circle-opacity": STOP_OPACITY,
      },
    },
    {
      id: "highlight-fill",
      type: "fill",
      source: "highlight",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": HIGHLIGHT_COLOR, "fill-opacity": 0.25 },
    },
    {
      id: "highlight-line",
      type: "line",
      source: "highlight",
      filter: ["!=", ["geometry-type"], "Point"],
      layout: { "line-cap": "round", "line-join": "round" },
      // A focused route's shapes carry its own colour, so the line reads as
      // the same route it is everywhere else; anything else - a row picked in
      // a table - has none and keeps the highlight's own.
      paint: {
        "line-color": ["coalesce", ["get", "highlight_color"], HIGHLIGHT_COLOR],
        "line-width": 5,
        "line-opacity": 0.95,
      },
    },
    {
      id: "highlight-point-outer",
      type: "circle",
      source: "highlight",
      filter: ["==", ["geometry-type"], "Point"],
      paint: { "circle-radius": 9, "circle-color": "#ffffff", "circle-opacity": 1 },
    },
    {
      id: "highlight-point",
      type: "circle",
      source: "highlight",
      filter: ["==", ["geometry-type"], "Point"],
      paint: { "circle-radius": 6, "circle-color": HIGHLIGHT_COLOR, "circle-opacity": 1 },
    },
  ];
}

function emptyStyle(): StyleSpec {
  return { version: 8, sources: {}, layers: [] };
}

/**
 * Build the complete style: the basemap underneath, the feed's layers on top.
 *
 * A vector basemap is fetched and merged rather than referenced by URL, so the
 * map is constructed from one complete style object and the feed's layers exist
 * from the first frame.
 */
export async function buildStyle(basemap: BasemapSpec): Promise<Record<string, unknown>> {
  let style = emptyStyle();

  if (basemap.kind === "vector" && basemap.url) {
    try {
      const response = await fetch(basemap.url);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      style = (await response.json()) as StyleSpec;
      // The published style carries no attribution, but the data and design
      // licences require it, so attach it to every source it came with.
      if (basemap.attribution) {
        for (const source of Object.values(style.sources) as Record<string, unknown>[]) {
          source.attribution = basemap.attribution;
        }
      }
    } catch (error) {
      console.error(`Basemap ${basemap.url} could not be loaded; continuing without one.`, error);
      style = emptyStyle();
    }
  } else if (basemap.kind === "raster" && basemap.url) {
    style.sources.basemap = {
      type: "raster",
      tiles: [basemap.url],
      tileSize: 256,
      attribution: basemap.attribution,
    };
    style.layers.push({ id: "basemap", type: "raster", source: "basemap", minzoom: 0, maxzoom: 22 });
  }

  Object.assign(style.sources, feedSources());
  style.layers.push(...feedLayers());
  return style;
}
