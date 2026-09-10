/**
 * MapLibre style for the feed.
 *
 * Sources and layers are declared up front rather than added in a `load`
 * handler: `load` only fires after the first paint, so in a background tab
 * (where requestAnimationFrame never runs) the layers would never exist and the
 * feed's data would silently never reach the map.
 *
 * Route colouring follows the same conventions as mobilitydatabase.org's map -
 * colour from `route_color`, width by `route_type`, a white casing underneath -
 * so the two read alike. The geometry itself is generated locally from the
 * feed's own shapes.txt; nothing here depends on that service.
 */

export const EMPTY_FEATURE_COLLECTION = {
  type: "FeatureCollection" as const,
  features: [],
};

const CARTO_BASEMAP = "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png";

const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
  '&copy; <a href="https://carto.com/attributions">CARTO</a>';

const geojsonSource = () => ({ type: "geojson", data: EMPTY_FEATURE_COLLECTION });

export const SOURCE_IDS = ["routes", "shapes", "stops", "highlight"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export function buildStyle(): Record<string, unknown> {
  return {
    version: 8,
    sources: {
      basemap: {
        type: "raster",
        tiles: [CARTO_BASEMAP],
        tileSize: 256,
        attribution: ATTRIBUTION,
      },
      routes: geojsonSource(),
      shapes: geojsonSource(),
      stops: geojsonSource(),
      highlight: geojsonSource(),
    },
    layers: [
      { id: "basemap", type: "raster", source: "basemap", minzoom: 0, maxzoom: 22 },
      // Shapes no route claims (feeds whose trips.txt has no shape_id) still
      // need drawing, otherwise those feeds render an empty map.
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
          // Scaled by zoom rather than hidden below z12 as the web app does -
          // in an inspection tool you need to see stops before zooming in.
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
    ],
  };
}
