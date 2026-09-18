import { describe, expect, it } from "vitest";

import type { FileMetrics, LoadMetrics } from "../sources/types";
import { fileRows, formatBytes, formatMs, phaseRows, summaryLine } from "./feed-metrics";

function file(name: string, bytes: number, extra: Partial<FileMetrics> = {}): FileMetrics {
  return {
    name,
    table: name.replace(/\.txt$/, ""),
    bytes,
    compressed_bytes: null,
    register_ms: 1,
    convert_ms: null,
    parquet_bytes: null,
    count_ms: 5,
    row_count: 10,
    columns: 4,
    ...extra,
  };
}

function metrics(extra: Partial<LoadMetrics> = {}): LoadMetrics {
  return {
    kind: "path",
    acquire_ms: null,
    acquire_bytes: null,
    extract_ms: null,
    register_ms: 12,
    convert_ms: null,
    count_ms: 30,
    total_ms: 42,
    total_bytes: 3000,
    stored_bytes: null,
    files: [file("agency.txt", 1000), file("stop_times.txt", 2000)],
    ...extra,
  };
}

describe("formatBytes", () => {
  it("leaves plain bytes whole", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("steps up a unit at 1024", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("drops the decimal once the number is wide enough to carry itself", () => {
    expect(formatBytes(48 * 1024 * 1024)).toBe("48 MB");
  });
});

describe("formatMs", () => {
  it("keeps a decimal below 10ms, where rounding would read as zero", () => {
    expect(formatMs(0.4)).toBe("0.4 ms");
  });

  it("rounds to whole milliseconds in between", () => {
    expect(formatMs(820.4)).toBe("820 ms");
  });

  it("switches to seconds at 1000ms", () => {
    expect(formatMs(3400)).toBe("3.4 s");
  });
});

describe("summaryLine", () => {
  it("reports files, size and server time", () => {
    expect(summaryLine(metrics())).toBe("2 files · 2.9 KB · 42 ms server");
  });

  it("reports the bytes that were read, not the archive they arrived in", () => {
    // A zip's own size is smaller than what it unpacks to, and the per-file
    // shares below are of the unpacked bytes.
    expect(summaryLine(metrics({ total_bytes: 900 }))).toContain("2.9 KB");
  });

  it("adds the round trip only when the client measured one", () => {
    expect(summaryLine(metrics(), 2400)).toContain("2.4 s round trip");
  });

  it("keeps the noun singular for a one-file feed", () => {
    expect(summaryLine(metrics({ files: [file("stops.txt", 10)] }))).toMatch(/^1 file /);
  });
});

describe("phaseRows", () => {
  it("omits acquire and unzip for a local folder", () => {
    expect(phaseRows(metrics()).map(([label]) => label)).toEqual(["Read headers", "Count rows"]);
  });

  it("names the acquire phase after how the feed arrived, with its size", () => {
    const rows = phaseRows(
      metrics({ kind: "download", acquire_ms: 1500, acquire_bytes: 2048, extract_ms: 90 }),
    );
    expect(rows).toEqual([
      ["Download", "1.5 s · 2.0 KB"],
      ["Unzip", "90 ms · 2.9 KB archive"],
      ["Read headers", "12 ms"],
      ["Count rows", "30 ms"],
    ]);
  });
});

describe("fileRows", () => {
  it("puts the largest file first, whatever order the server sent", () => {
    expect(fileRows(metrics()).map((row) => row.name)).toEqual(["stop_times.txt", "agency.txt"]);
  });

  it("reports each file's share of the total", () => {
    expect(fileRows(metrics()).map((row) => row.share)).toEqual([67, 33]);
  });

  it("shows a dash where the server had no number", () => {
    const row = fileRows(metrics({ files: [file("stops.txt", 1, { count_ms: null, row_count: null })] }))[0];
    expect(row.compressed).toBe("—");
    expect(row.costMs).toBe("—");
    expect(row.rows).toBe("—");
  });

  it("does not divide by zero on a feed of empty files", () => {
    expect(fileRows(metrics({ files: [file("stops.txt", 0)] }))[0].share).toBe(0);
  });

  /**
   * The two numbers this replaced were measured against different storage - the
   * header read on the CSV before conversion, the row count on the Parquet
   * after it - so the single cost has to follow whichever actually happened.
   */
  it("reports the conversion when the feed was converted", () => {
    const converted = metrics({
      convert_ms: 40,
      files: [file("stops.txt", 1, { convert_ms: 12, count_ms: 0.2 })],
    });
    expect(fileRows(converted)[0].costMs).toBe("12 ms");
  });

  it("reports the row count when the feed was left as CSV", () => {
    const plain = metrics({
      convert_ms: null,
      files: [file("stops.txt", 1, { convert_ms: null, count_ms: 30 })],
    });
    expect(fileRows(plain)[0].costMs).toBe("30 ms");
  });

  it("dashes a file that would not convert inside a converted feed", () => {
    const partial = metrics({
      convert_ms: 40,
      files: [file("broken.txt", 1, { convert_ms: null, count_ms: 5 })],
    });
    // Its CSV view survives, so there is no conversion time to report - and
    // the count belongs to the other mode, so it is not substituted in.
    expect(fileRows(partial)[0].costMs).toBe("—");
  });
});
const SERVER: LoadMetrics = {
  kind: "download",
  acquire_ms: 6200,
  acquire_bytes: 4_500_000,
  extract_ms: 1100,
  register_ms: 14,
  convert_ms: 6000,
  count_ms: 90,
  total_ms: 13_404,
  total_bytes: 4_500_000,
  stored_bytes: 220_000,
  files: [],
};

/**
 * The panel asks what the feed cost to open. For a server load that is a
 * download, an unzip and a conversion; for a browser reading Parquet none of
 * those happened, and reporting them as zero would claim work that did not.
 */
describe("phaseRows", () => {
  it("describes a server load from its fields", () => {
    const labels = phaseRows(SERVER).map(([label]) => label);
    expect(labels).toEqual(["Download", "Unzip", "Read headers", "Convert to Parquet", "Count rows"]);
  });

  it("takes a source that described its own work at its word", () => {
    const rows = phaseRows({
      ...SERVER,
      phases: [
        { label: "Start DuckDB", ms: 420, note: "74 kB fetched" },
        { label: "First query", ms: 38 },
      ],
    });
    expect(rows).toEqual([
      ["Start DuckDB", "420 ms · 74 kB fetched"],
      ["First query", "38 ms"],
    ]);
  });

  it("never mixes the two", () => {
    // The server fields are still present above; a source that supplied phases
    // must not also get Unzip and Convert rows it never performed.
    const labels = phaseRows({ ...SERVER, phases: [{ label: "Start DuckDB", ms: 1 }] }).map(([l]) => l);
    expect(labels).toEqual(["Start DuckDB"]);
  });
});
