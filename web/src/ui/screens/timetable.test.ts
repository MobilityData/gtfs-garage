import { describe, expect, it } from "vitest";

import type { Filter, ViewerSource } from "../../sources/types";
import { departure, TripShapes } from "./timetable";

const call = (time: string, stop_sequence: number | null) => ({
  arrival: time,
  departure: time,
  stop_sequence,
});

describe("departure", () => {
  it("is the trip's first call by stop_sequence, not its topmost row", () => {
    // OC Transpo's 82: Pinecrest Mall is the top row, reached 46 stops after
    // the trip leaves Baseline.
    const calls = [call("10:18:00", 47), call("09:47:00", 1), null];
    expect(departure(calls)).toEqual({ call: calls[1], index: 1 });
  });

  it("skips rows the trip does not call at, and calls with no time", () => {
    const calls = [null, { arrival: null, departure: null, stop_sequence: 1 }, call("07:47:00", 2)];
    expect(departure(calls)?.index).toBe(2);
  });

  it("falls back to grid order when the feed states no sequence", () => {
    const calls = [null, call("06:00:00", null), call("05:00:00", null)];
    expect(departure(calls)?.index).toBe(1);
  });

  it("is null for a trip with no times at all", () => {
    expect(departure([null, null])).toBeNull();
  });
});

describe("TripShapes", () => {
  /** A source answering trips.txt from a map, recording what it was asked. */
  const source = (shapes: Record<string, string | null>, fail = false) => {
    const asked: string[][] = [];
    const fake = {
      query: async (_table: string, filters: Filter[]) => {
        if (fail) throw new Error("offline");
        const ids = (filters[0].value ?? "").split(",");
        asked.push(ids);
        return {
          columns: ["trip_id", "shape_id"],
          rows: ids.filter((id) => id in shapes).map((id) => [id, shapes[id]]),
          total: ids.length,
          page: 1,
          page_size: ids.length,
        };
      },
    } as unknown as ViewerSource;
    return { fake, asked };
  };

  it("gives the distinct shapes the trips follow, and only theirs", async () => {
    const { fake } = source({ a: "S1", b: "S1", c: "S2", school: "S9" });
    expect(await new TripShapes(fake).of(["a", "b", "c"])).toEqual(["S1", "S2"]);
  });

  it("asks once per trip, in batches", async () => {
    const ids = Array.from({ length: 250 }, (_, index) => `t${index}`);
    const { fake, asked } = source(Object.fromEntries(ids.map((id) => [id, "S1"])));
    const shapes = new TripShapes(fake);
    await shapes.of(ids);
    await shapes.of(["t1", "t2"]);
    expect(asked.map((batch) => batch.length)).toEqual([100, 100, 50]);
  });

  it("leaves out trips with no shape, and survives a failed lookup", async () => {
    expect(await new TripShapes(source({ a: null }).fake).of(["a", "missing"])).toEqual([]);
    expect(await new TripShapes(source({}, true).fake).of(["a"])).toEqual([]);
  });
});
