import { describe, expect, it } from "vitest";

import type { LoadProgress } from "../sources/types";
import { progressLine } from "./load-progress";

function progress(extra: Partial<LoadProgress> = {}): LoadProgress {
  return { phase: "download", done: 0, total: 0, detail: "", running: true, ...extra };
}

describe("progressLine", () => {
  it("falls back to what was asked for before the server reports anything", () => {
    expect(progressLine(null, "feed.zip")).toBe("Loading feed.zip…");
  });

  it("does not claim to be downloading a local path", () => {
    // A load begins before anything knows whether there is a download at all.
    expect(progressLine(progress({ phase: "start" }), "/data/feed.zip")).toBe("Loading /data/feed.zip…");
  });

  it("falls back again once the load is no longer running", () => {
    expect(progressLine(progress({ running: false }), "feed.zip")).toBe("Loading feed.zip…");
  });

  it("counts a download in bytes against its total", () => {
    const line = progressLine(progress({ done: 212 * 1024 ** 2, total: 577 * 1024 ** 2 }), "x");
    expect(line).toBe("Downloading 212 MB of 577 MB");
  });

  it("omits the total when the server declared no Content-Length", () => {
    expect(progressLine(progress({ done: 1024 }), "x")).toBe("Downloading 1.0 KB");
  });

  it("counts unzipping in files and names the one in hand", () => {
    const line = progressLine(progress({ phase: "extract", done: 9, total: 16, detail: "stops.txt" }), "x");
    expect(line).toBe("Unzipping stops.txt (9 of 16)");
  });

  it("names the table being converted", () => {
    const line = progressLine(progress({ phase: "convert", done: 3, total: 16, detail: "stop_times" }), "x");
    expect(line).toBe("Converting stop_times (3 of 16)");
  });

  it("has nothing to count while rows are being summarised", () => {
    expect(progressLine(progress({ phase: "summarise" }), "x")).toBe("Counting rows…");
  });
});
