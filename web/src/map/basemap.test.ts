import { describe, expect, it, vi } from "vitest";

import { BASEMAPS, DEFAULT_BASEMAP, resolveBasemap } from "./basemap";

describe("resolveBasemap", () => {
  it("defaults when nothing is configured", () => {
    expect(resolveBasemap(undefined)).toBe(BASEMAPS[DEFAULT_BASEMAP]);
    expect(resolveBasemap(null)).toBe(BASEMAPS[DEFAULT_BASEMAP]);
    expect(resolveBasemap("")).toBe(BASEMAPS[DEFAULT_BASEMAP]);
  });

  it("resolves preset names", () => {
    expect(resolveBasemap("esri").kind).toBe("raster");
    expect(resolveBasemap("openfreemap").kind).toBe("vector");
    expect(resolveBasemap("none").kind).toBe("none");
  });

  it("treats a tile template as a raster source", () => {
    const spec = resolveBasemap("https://example.org/tiles/{z}/{x}/{y}.png");
    expect(spec.kind).toBe("raster");
    expect(spec.url).toContain("{z}");
  });

  it("treats any other URL as a vector style", () => {
    expect(resolveBasemap("https://example.org/styles/custom").kind).toBe("vector");
  });

  it("falls back with a warning on an unknown name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveBasemap("nonsense")).toBe(BASEMAPS[DEFAULT_BASEMAP]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("licence obligations", () => {
  it("every preset that serves map data credits its source", () => {
    for (const [name, spec] of Object.entries(BASEMAPS)) {
      if (spec.kind === "none") continue;
      expect(spec.attribution, `${name} must carry attribution`).toBeTruthy();
    }
  });

  it("presets built on OpenStreetMap data credit OpenStreetMap", () => {
    for (const name of ["openfreemap", "osm", "carto"]) {
      expect(BASEMAPS[name].attribution).toContain("OpenStreetMap");
    }
  });
});
