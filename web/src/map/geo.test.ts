import { describe, expect, it } from "vitest";

import type { FeatureCollection } from "../sources/types";
import { bboxOf } from "./geo";

const collection = (features: unknown[]): FeatureCollection =>
  ({ type: "FeatureCollection", features }) as FeatureCollection;

describe("bboxOf", () => {
  it("returns null for an empty collection", () => {
    expect(bboxOf(collection([]))).toBeNull();
  });

  it("returns null when features carry no geometry", () => {
    expect(bboxOf(collection([{ geometry: null, properties: {} }]))).toBeNull();
  });

  it("bounds a single point", () => {
    const fc = collection([{ geometry: { type: "Point", coordinates: [-73.5, 45.5] }, properties: {} }]);
    expect(bboxOf(fc)).toEqual([-73.5, 45.5, -73.5, 45.5]);
  });

  it("bounds a line", () => {
    const fc = collection([
      {
        geometry: {
          type: "LineString",
          coordinates: [
            [-73.6, 45.4],
            [-73.4, 45.6],
          ],
        },
        properties: {},
      },
    ]);
    expect(bboxOf(fc)).toEqual([-73.6, 45.4, -73.4, 45.6]);
  });

  it("spans every feature in the collection", () => {
    const fc = collection([
      { geometry: { type: "Point", coordinates: [0, 0] }, properties: {} },
      { geometry: { type: "Point", coordinates: [10, -10] }, properties: {} },
    ]);
    expect(bboxOf(fc)).toEqual([0, -10, 10, 0]);
  });

  it("handles negative coordinates without treating them as missing", () => {
    const fc = collection([{ geometry: { type: "Point", coordinates: [-1, -1] }, properties: {} }]);
    expect(bboxOf(fc)).toEqual([-1, -1, -1, -1]);
  });
});
