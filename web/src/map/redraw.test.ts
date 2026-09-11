import { describe, expect, it } from "vitest";

import { createRedrawSchedule, FIRST_REDRAW_AT } from "./redraw";

/** Redraws triggered while a layer of `total` features arrives in batches. */
function redrawsFor(total: number, batch = 5000): number {
  const due = createRedrawSchedule();
  let redraws = 0;
  for (let drawn = batch; drawn <= total; drawn += batch) {
    if (due(drawn)) redraws += 1;
  }
  return redraws;
}

describe("createRedrawSchedule", () => {
  it("draws nothing until the first batch is worth drawing", () => {
    const due = createRedrawSchedule();
    expect(due(FIRST_REDRAW_AT - 1)).toBe(false);
    expect(due(FIRST_REDRAW_AT)).toBe(true);
  });

  it("then waits for the layer to double", () => {
    const due = createRedrawSchedule(100, 2);
    expect([100, 150, 200, 300, 400].map(due)).toEqual([true, false, true, false, true]);
  });

  /**
   * The guard that matters. Every redraw re-indexes the whole collection, so a
   * schedule proportional to the layer is quadratic work: 50 redraws of a
   * quarter-million features is what took minutes before.
   */
  it("stays in single digits for a quarter of a million features", () => {
    expect(redrawsFor(250_000)).toBeLessThan(10);
  });

  it("adds one redraw when the layer doubles, not double the redraws", () => {
    const small = redrawsFor(250_000);
    expect(redrawsFor(500_000)).toBe(small + 1);
  });

  it("is not fooled by small batches", () => {
    // Arrival size must not change how often the layer is re-indexed.
    expect(redrawsFor(250_000, 500)).toBe(redrawsFor(250_000, 5000));
  });
});
