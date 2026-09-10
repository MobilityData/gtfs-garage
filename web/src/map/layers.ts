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

export const SOURCE_IDS = ["routes", "shapes", "stops", "highlight"] as const;
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
        "line-width": ["match", ["get", "route_type"], "3", 5, "1", 10, 7],
        "line-opacity": 0.8,
      },
    },
    {
      id: "routes",
      type: "line",
      source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["concat", "#", ["get", "route_color"]],
        "line-width": ["match", ["get", "route_type"], "3", 1, "1", 4, 3],
        "line-opacity": ["match", ["get", "route_type"], "1", 0.8, "3", 0.6, 0.7],
      },
    },
    {
      id: "stops",
      type: "circle",
      source: "stops",
      paint: {
        // Scaled by zoom rather than hidden at low zoom: an inspection tool has
        // to show where the stops are before you know where to zoom.
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 1.5, 12, 3, 16, 5],
        "circle-color": "#1c1e21",
        "circle-opacity": 0.45,
      },
    },
    {
      id: "highlight-line",
      type: "line",
      source: "highlight",
      filter: ["!=", ["geometry-type"], "Point"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ff0066", "line-width": 5, "line-opacity": 0.95 },
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
      paint: { "circle-radius": 6, "circle-color": "#ff0066", "circle-opacity": 1 },
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
