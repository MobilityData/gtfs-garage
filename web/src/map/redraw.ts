/**
 * When to hand a growing layer to MapLibre while it is still arriving.
 *
 * Its own module because vitest runs with no DOM, so anything inside
 * `MapController` is untestable - the same constraint `Navigator.parseUrl` is
 * written around. The schedule is the part worth testing: get it wrong and a
 * large feed takes minutes to draw.
 */

/**
 * Redraw once the layer has grown by this factor, rather than on a timer.
 *
 * `setData` re-serialises and re-indexes the whole collection every call, so
 * the cost of a redraw grows with the layer. Redrawing at a fixed interval - or
 * worse, per batch - therefore does work proportional to the square of the
 * feature count, which is what made a quarter of a million shapes take minutes.
 * Growth-based redrawing keeps the total proportional to the layer itself, and
 * widens the gaps in a way that still reads as filling in.
 *
 * `GeoJSONSource.updateData` would remove the need for any of this, but in
 * MapLibre 5.7 it accepts a diff and silently discards it.
 */
export const REDRAW_GROWTH_FACTOR = 2;

/** Features worth drawing before waiting for the layer to double. */
export const FIRST_REDRAW_AT = 5000;

/**
 * Returns a predicate: given how many features have arrived, should the layer
 * be redrawn now? Stateful across calls, one per layer being drawn.
 */
export function createRedrawSchedule(
  firstAt: number = FIRST_REDRAW_AT,
  factor: number = REDRAW_GROWTH_FACTOR,
): (featureCount: number) => boolean {
  let next = firstAt;
  return (featureCount: number): boolean => {
    if (featureCount < next) return false;
    next *= factor;
    return true;
  };
}
