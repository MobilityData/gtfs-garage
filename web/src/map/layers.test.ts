import { afterEach, describe, expect, it, vi } from "vitest";

import { BASEMAPS } from "./basemap";
import { buildStyle, SOURCE_IDS } from "./layers";

type Style = { sources: Record<string, any>; layers: { id: string; source?: string }[] };

afterEach(() => {
  vi.unstubAllGlobals();
});

const feedLayerIds = [
  "locations-fill",
  "locations-outline",
  "shapes",
  "routes-white",
  "routes",
  "stops",
  "highlight-fill",
  "highlight-line",
];

describe("buildStyle", () => {
  it("includes the feed's sources and layers with no basemap", async () => {
    const style = (await buildStyle(BASEMAPS.none)) as Style;
    for (const id of SOURCE_IDS) expect(style.sources[id]).toBeDefined();
    for (const id of feedLayerIds) expect(style.layers.map((l) => l.id)).toContain(id);
  });

  it("puts a raster basemap underneath the feed's layers", async () => {
    const style = (await buildStyle(BASEMAPS.esri)) as Style;
    expect(style.layers[0].id).toBe("basemap");
    expect(style.layers.at(-1)?.id).toBe("highlight-point");
  });

  it("draws the flex zones beneath the lines", async () => {
    // A zone is an area a rider can be picked up in, not something drawn over
    // the network - if it sat on top it would wash out the routes it contains.
    const style = (await buildStyle(BASEMAPS.none)) as Style;
    const at = (id: string) => style.layers.findIndex((l) => l.id === id);
    expect(at("locations-fill")).toBeLessThan(at("routes"));
    expect(at("locations-outline")).toBeLessThan(at("shapes"));
  });

  it("carries the raster basemap's attribution onto its source", async () => {
    const style = (await buildStyle(BASEMAPS.esri)) as Style;
    expect(style.sources.basemap.attribution).toContain("Esri");
  });

  it("merges a fetched vector style and attributes its sources", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          version: 8,
          sources: { openmaptiles: { type: "vector", url: "https://example.org/planet" } },
          layers: [{ id: "background", type: "background" }],
        }),
      })),
    );

    const style = (await buildStyle(BASEMAPS.openfreemap)) as Style;

    // The upstream style may declare none, but the data licence requires it.
    expect(style.sources.openmaptiles.attribution).toContain("OpenStreetMap");
    expect(style.layers[0].id).toBe("background");
    for (const id of SOURCE_IDS) expect(style.sources[id]).toBeDefined();
  });

  it("still renders the feed when the basemap cannot be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, statusText: "nope" })));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const style = (await buildStyle(BASEMAPS.openfreemap)) as Style;

    expect(error).toHaveBeenCalled();
    for (const id of SOURCE_IDS) expect(style.sources[id]).toBeDefined();
    expect(style.layers.map((l) => l.id)).toContain("routes");
    error.mockRestore();
  });
});
