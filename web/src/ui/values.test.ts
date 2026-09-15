import { describe, expect, it } from "vitest";

import { columnInfo } from "../sources/fixtures";
import type { ColumnInfo } from "../sources/types";
import { describeColumn, renderValue } from "./values";

const column = (type: string | null, values: Record<string, string> | null = null): ColumnInfo =>
  columnInfo({ type, values });

const ROUTE_TYPES = { "0": "Light Rail", "3": "Bus" };

describe("enumerations", () => {
  it("shows the label beside the code", () => {
    expect(renderValue("3", column("ENUM", ROUTE_TYPES)).text).toBe("Bus (3)");
  });

  it("shows an unknown code raw and does not call it malformed", () => {
    // GTFS defines extended route types from 100 to 1700 which the schema does
    // not enumerate, so an unrecognised code is normal rather than an error.
    const rendered = renderValue("700", column("ENUM", ROUTE_TYPES));
    expect(rendered.text).toBe("700");
    expect(rendered.malformed).toBeUndefined();
  });
});

describe("colours", () => {
  it("offers a swatch for six hex digits", () => {
    expect(renderValue("FF0000", column("COLOR"))).toMatchObject({
      kind: "color",
      swatch: "#FF0000",
    });
  });

  it("shows a leading # as malformed, because GTFS forbids it", () => {
    const rendered = renderValue("#FF0000", column("COLOR"));
    expect(rendered).toMatchObject({ kind: "plain", text: "#FF0000" });
    expect(rendered.malformed).toContain("without a leading #");
  });

  it.each(["red", "FF00", "", "GGGGGG"])("shows %o as the raw string", (value) => {
    expect(renderValue(value, column("COLOR")).text).toBe(value);
  });
});

/**
 * The security property. Before this module no feed value was ever used as an
 * href, so links are a new attack surface and a feed is untrusted input.
 */
describe("links never execute", () => {
  it.each([
    "javascript:alert(document.cookie)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "//evil.example/path",
    "not a url at all",
  ])("refuses to link %o", (value) => {
    const rendered = renderValue(value, column("URL"));
    expect(rendered.kind).toBe("plain");
    expect(rendered.href).toBeUndefined();
    expect(rendered.text).toBe(value);
  });

  it.each(["https://example.org/gtfs", "http://example.org"])("links %o", (value) => {
    expect(renderValue(value, column("URL")).kind).toBe("link");
  });

  it("turns an address into a mailto link", () => {
    expect(renderValue("ops@example.org", column("EMAIL"))).toMatchObject({
      kind: "link",
      href: "mailto:ops@example.org",
    });
  });

  it("does not let an email field smuggle another scheme", () => {
    expect(renderValue("javascript:alert(1)", column("EMAIL")).kind).toBe("plain");
  });
});

describe("coordinates", () => {
  it("treats a valid latitude as a number", () => {
    expect(renderValue("45.5017", column("LATITUDE")).kind).toBe("numeric");
  });

  it("keeps the feed's own precision rather than reformatting", () => {
    // 45.50000 and 45.5 are the same number and different text; the producer
    // chose the text, and an inspection tool shows what is there.
    expect(renderValue("45.50000", column("LATITUDE")).text).toBe("45.50000");
  });

  it.each(["N/A", "999", "", "-", "45,5017"])("shows %o raw", (value) => {
    const rendered = renderValue(value, column("LATITUDE"));
    expect(rendered.text).toBe(value);
    expect(rendered.kind).toBe("plain");
  });

  it("rejects a longitude outside the world", () => {
    expect(renderValue("181", column("LONGITUDE")).malformed).toBeTruthy();
    expect(renderValue("-180", column("LONGITUDE")).kind).toBe("numeric");
  });
});

describe("dates", () => {
  it("reads YYYYMMDD", () => {
    expect(renderValue("20260822", column("DATE")).text).not.toBe("20260822");
  });

  it.each(["2026-08-22", "20260231", "notadate", ""])("shows %o raw", (value) => {
    // 20260231 is the interesting one: a naive Date rolls it into March.
    expect(renderValue(value, column("DATE")).text).toBe(value);
  });
});

describe("what is deliberately left alone", () => {
  it("does not touch a time past midnight", () => {
    // Valid GTFS for a trip running past midnight; "correcting" it would be
    // worse than doing nothing.
    expect(renderValue("25:30:00", column("TIME")).text).toBe("25:30:00");
  });

  it("passes through a column the schema does not describe", () => {
    expect(renderValue("anything", column(null)).text).toBe("anything");
    expect(renderValue("anything", undefined).text).toBe("anything");
  });
});

describe("nothing breaks", () => {
  const HOSTILE = ["<script>alert(1)</script>", "x".repeat(10_000), " ", "\\u0000", "%%%"];
  const TYPES = ["ENUM", "COLOR", "URL", "EMAIL", "DATE", "LATITUDE", "INTEGER", "TIME", "ID", null];

  it("renders every hostile value for every type without throwing", () => {
    for (const type of TYPES) {
      for (const value of HOSTILE) {
        const rendered = renderValue(value, column(type, ROUTE_TYPES));
        expect(typeof rendered.text).toBe("string");
      }
    }
  });

  it("never returns an href for a hostile value", () => {
    for (const value of HOSTILE) {
      expect(renderValue(value, column("URL")).href).toBeUndefined();
    }
  });

  it("renders a missing value as empty rather than the word null", () => {
    expect(renderValue(null, column("TEXT")).text).toBe("");
  });
});

describe("column descriptions", () => {
  const withRequired = (required: string | null, condition: string | null = null): ColumnInfo =>
    columnInfo({ type: "TEXT", required, condition });

  it("names the type and that the field is required", () => {
    expect(describeColumn(withRequired("always"))).toBe("TEXT · Required");
  });

  it("states the condition rather than the word conditional", () => {
    expect(describeColumn(withRequired("conditional", "Required if route_long_name is empty."))).toBe(
      "TEXT · Conditionally required - Required if route_long_name is empty.",
    );
  });

  it("falls back when a condition is not recorded", () => {
    expect(describeColumn(withRequired("conditional"))).toBe("TEXT · Conditionally required");
  });

  it("says only the type for an optional field", () => {
    expect(describeColumn(withRequired(null))).toBe("TEXT");
  });

  it("says nothing about a column the schema does not describe", () => {
    expect(describeColumn(undefined)).toBe("");
  });
});

/**
 * The escape hatch. Formatting is a reading aid, and a reading aid is the wrong
 * thing when the question is what the producer actually wrote.
 */
describe("raw mode", () => {
  const RAW_CASES: [string, ColumnInfo][] = [
    ["20260822", column("DATE")],
    ["3", column("ENUM", ROUTE_TYPES)],
    ["FF0000", column("COLOR")],
    ["https://example.org/gtfs", column("URL")],
    ["ops@example.org", column("EMAIL")],
    ["45.50000", column("LATITUDE")],
    ["25:30:00", column("TIME")],
  ];

  it.each(RAW_CASES)("shows %o exactly as the feed has it", (value, info) => {
    expect(renderValue(value, info, true)).toEqual({ text: value, kind: "plain" });
  });

  it("makes no links, so nothing is clickable that was not before", () => {
    for (const [value, info] of RAW_CASES) {
      const rendered = renderValue(value, info, true);
      expect(rendered.href).toBeUndefined();
      expect(rendered.swatch).toBeUndefined();
    }
  });

  it("does not flag a malformed value, because nothing is being checked", () => {
    expect(renderValue("#FF0000", column("COLOR"), true).malformed).toBeUndefined();
    expect(renderValue("999", column("LATITUDE"), true).malformed).toBeUndefined();
  });

  it("still shows a missing value as empty rather than the word null", () => {
    expect(renderValue(null, column("TEXT"), true).text).toBe("");
  });

  it("formats again when raw is off", () => {
    expect(renderValue("3", column("ENUM", ROUTE_TYPES), false).text).toBe("Bus (3)");
  });
});
