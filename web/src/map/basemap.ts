/**
 * The backdrop under the feed's geometry.
 *
 * Presets are keyless, except CARTO, which watermarks its tiles unless an API
 * key is appended to the URL.
 *
 * Attribution is a licence obligation, not decoration: OpenStreetMap data is
 * ODbL and the styles are CC BY, both of which require credit. It is declared
 * here rather than taken from the upstream style, which may not carry any.
 */

export interface BasemapSpec {
  kind: "vector" | "raster" | "none";
  /** Style URL for vector, tile template for raster. */
  url?: string;
  attribution?: string;
}

const OSM_CREDIT = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export const BASEMAPS: Record<string, BasemapSpec> = {
  openfreemap: {
    kind: "vector",
    url: "https://tiles.openfreemap.org/styles/positron",
    attribution: `<a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> ${OSM_CREDIT}`,
  },
  esri: {
    kind: "raster",
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a>',
  },
  osm: {
    kind: "raster",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: OSM_CREDIT,
  },
  // Needs ?api_key=... appended, otherwise the tiles carry a watermark.
  carto: {
    kind: "raster",
    url: "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    attribution: `${OSM_CREDIT} &copy; <a href="https://carto.com/attributions">CARTO</a>`,
  },
  none: { kind: "none" },
};

export const DEFAULT_BASEMAP = "openfreemap";

/**
 * Turn a configured value into a spec. Accepts a preset name, a raster tile
 * template (recognised by its {z}/{x}/{y} placeholders), or a vector style URL.
 */
export function resolveBasemap(value?: string | null): BasemapSpec {
  if (!value) return BASEMAPS[DEFAULT_BASEMAP];
  if (value in BASEMAPS) return BASEMAPS[value];

  if (value.includes("{z}") && value.includes("{x}") && value.includes("{y}")) {
    return { kind: "raster", url: value };
  }
  if (value.startsWith("http")) {
    return { kind: "vector", url: value };
  }
  console.warn(`Unknown basemap "${value}"; falling back to ${DEFAULT_BASEMAP}.`);
  return BASEMAPS[DEFAULT_BASEMAP];
}
