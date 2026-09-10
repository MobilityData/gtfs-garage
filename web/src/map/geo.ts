import type { FeatureCollection } from "../sources/types";

export type Bbox = [number, number, number, number];

/** Bounding box of every coordinate in a collection, or null if it has none. */
export function bboxOf(collection: FeatureCollection): Bbox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const visit = (coords: unknown): void => {
    if (Array.isArray(coords) && typeof coords[0] === "number") {
      const [x, y] = coords as [number, number];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    } else if (Array.isArray(coords)) {
      coords.forEach(visit);
    }
  };

  for (const feature of collection.features) {
    if (feature.geometry) visit(feature.geometry.coordinates);
  }

  return minX === Infinity ? null : [minX, minY, maxX, maxY];
}
