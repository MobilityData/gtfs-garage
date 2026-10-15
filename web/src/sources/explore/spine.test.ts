import { describe, expect, it } from "vitest";

import { secondsFromClock, spine } from "./derive";

/**
 * The row order a timetable is drawn in. A route's trips do not all call
 * everywhere, and the grid needs one order holding every one of them - with the
 * odd stops where they happen on the ground, not appended at the bottom where
 * they would read as the end of the line.
 */
describe("spine", () => {
  it("is the longest sequence when every trip follows it", () => {
    expect(spine([["a", "b", "c"], ["a", "b", "c"]])).toEqual(["a", "b", "c"]);
  });

  it("keeps a short working's stops in place rather than adding rows", () => {
    expect(spine([["a", "b", "c"], ["a", "b"]])).toEqual(["a", "b", "c"]);
  });

  it("weaves an extra stop in after the stop it follows", () => {
    expect(spine([["a", "b", "d"], ["a", "b", "c", "d"]])).toEqual(["a", "b", "c", "d"]);
  });

  it("puts a stop only one trip calls at where that trip calls at it", () => {
    // The school journey that detours between b and c.
    expect(spine([["a", "b", "c"], ["a", "b", "x", "c"]])).toEqual(["a", "b", "x", "c"]);
  });

  it("handles a trip that starts before the longest one does", () => {
    expect(spine([["b", "c"], ["z", "b", "c"]])).toEqual(["z", "b", "c"]);
  });

  it("has nothing to order for a route with no trips", () => {
    expect(spine([])).toEqual([]);
  });
});

describe("secondsFromClock", () => {
  it("reads an ordinary time", () => {
    expect(secondsFromClock("06:30:00")).toBe(6 * 3600 + 30 * 60);
  });

  it("keeps an hour past midnight rather than wrapping it", () => {
    // 25:10 belongs to the service day before; wrapping it would sort the last
    // trip of the night to the front of the timetable it ends.
    expect(secondsFromClock("25:10:00")).toBe(25 * 3600 + 10 * 60);
  });

  it("has no answer for an empty or malformed time", () => {
    expect(secondsFromClock(null)).toBeNull();
    expect(secondsFromClock("")).toBeNull();
    expect(secondsFromClock("half past six")).toBeNull();
  });
});
