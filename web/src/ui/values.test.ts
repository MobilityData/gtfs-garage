import { describe, expect, it } from "vitest";

import { columnInfo, typedColumn } from "../sources/fixtures";
import type { ColumnInfo } from "../sources/types";
import { describeColumn, renderValue } from "./values";

/**
 * A column as the server would send it: the type, plus whatever the schema
 * publishes for that type.
 *
 * The constraints are read from the generated document rather than written out
 * here, so these tests check the rules the application actually ships. A regex
 * copied into this file would let the schema and the viewer disagree while both
 * looked tested - which is the situation this change exists to end.
 */
const column = (type: string | null, values: Record<string, string> | null = null): ColumnInfo =>
  type === null ? columnInfo({ type, values }) : typedColumn(type, { values });

const ROUTE_TYPES = { "0": "Light Rail", "3": "Bus" };

describe("enumerations", () => {
  it("shows the label beside the code", () => {
    expect(renderValue("3", column("ENUM", ROUTE_TYPES)).text).toBe("Bus (3)");
  });

  it("does not repeat a code that is already its own label", () => {
    // GTFS enumerates geometry types by name, so the code and the label are the
    // same word.
    expect(renderValue("Polygon", column("ENUM", { Polygon: "Polygon" })).text).toBe("Polygon");
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

/**
 * `mailto:` followed by any colon-free string is a valid URL, so relying on the
 * URL parser alone linked "hello" and "   " as working addresses while the
 * tooltip claimed they had been checked. The rule that fixes it is a `pattern`
 * on `Email` in schema/gtfs.yaml, applied here by way of the published
 * document - structural, not RFC 5322, whose grammar is not a regular language.
 */
describe("email addresses", () => {
  it.each(["ops@example.org", "a.b+tag@sub.example.co.uk", "用户@例子.广告", "x@y"])(
    "links %o",
    (value) => {
      expect(renderValue(value, column("EMAIL")).kind).toBe("link");
    },
  );

  it.each(["not an email at all", "hello", "@@@", "@example.org", "ops@", "", "   ", "<script>", "a@b@c"])(
    "flags %o rather than linking it",
    (value) => {
      const rendered = renderValue(value, column("EMAIL"));
      expect(rendered.kind).toBe("plain");
      expect(rendered.href).toBeUndefined();
      expect(rendered.malformed).toBe("an email address");
    },
  );

  it("shows a flagged address exactly as the feed has it", () => {
    // The point of flagging rather than hiding: the reader has to see what the
    // producer actually wrote in order to fix it.
    expect(renderValue("not an email at all", column("EMAIL")).text).toBe("not an email at all");
  });

  it("does not accept an address carrying a scheme of its own", () => {
    // Caught before the URL parser sees it, so the guarantee does not depend on
    // the scheme allowlist alone.
    for (const value of ["javascript:a@b", "data:a@b", "mailto:ops@example.org"]) {
      expect(renderValue(value, column("EMAIL")).kind).toBe("plain");
    }
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
 * Some GTFS conditions cannot be settled by the row that carries them. Where
 * the server has settled one against the loaded feed, the header says the
 * answer; where it cannot, it says so rather than reading like the ones it can.
 */
describe("conditions that reach outside the row", () => {
  const conditional = (overrides: Partial<ColumnInfo>): ColumnInfo =>
    columnInfo({
      type: "ID",
      required: "conditional",
      condition: "Required when the feed contains more than one agency.",
      ...overrides,
    });

  const AGENCY = "Required when the feed contains more than one agency.";

  it("states the answer, and what it was counted from", () => {
    const column = conditional({
      condition_scope: "feed",
      condition_outcome: { holds: true, evidence: "agency.txt has 3 rows" },
    });
    expect(describeColumn(column)).toBe(`ID · Required in this feed (agency.txt has 3 rows) - ${AGENCY}`);
  });

  it("says so just as plainly when the condition does not hold", () => {
    // The case a feed with one agency hits, and the one that distinguishes a
    // check that ran from a check that never did.
    const column = conditional({
      condition_scope: "feed",
      condition_outcome: { holds: false, evidence: "agency.txt has 1 row" },
    });
    expect(describeColumn(column)).toBe(`ID · Not required in this feed (agency.txt has 1 row) - ${AGENCY}`);
  });

  it("keeps the condition beside the answer, so the answer can be argued with", () => {
    for (const holds of [true, false]) {
      const column = conditional({
        condition_scope: "feed",
        condition_outcome: { holds, evidence: "agency.txt has 2 rows" },
      });
      expect(describeColumn(column)).toContain(AGENCY);
    }
  });

  it("does not claim an answer for a condition that varies by row", () => {
    const column = conditional({
      condition_scope: "row_context",
      condition: "Required for the first and last stop of a trip, and if timepoint=1.",
      type: "TIME",
    });
    expect(describeColumn(column)).toBe(
      "TIME · Conditionally required, row by row - " +
        "Required for the first and last stop of a trip, and if timepoint=1.",
    );
  });

  it("falls back to the plain wording when the check could not run", () => {
    // A feed with no agency.txt, or a schema naming a check this build does not
    // have. Either way there is no answer to report.
    const column = conditional({ condition_scope: "feed", condition_outcome: null });
    expect(describeColumn(column)).toBe(`ID · Conditionally required - ${AGENCY}`);
  });

  it("leaves a condition the row settles exactly as it was", () => {
    const column = columnInfo({
      type: "TEXT",
      required: "conditional",
      condition: "Required if route_long_name is empty.",
      condition_scope: "row",
    });
    expect(describeColumn(column)).toBe("TEXT · Conditionally required - Required if route_long_name is empty.");
  });

  it("ignores a scope on a field that is not conditional", () => {
    const column = columnInfo({ type: "ID", required: "always", condition_scope: "feed" });
    expect(describeColumn(column)).toBe("ID · Required");
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

/**
 * GTFS gives many empty enum fields a meaning - "0 or empty - Regularly
 * scheduled pickup". A blank cell therefore carries a value that is simply not
 * written down.
 */
describe("what an empty field implies", () => {
  const implied = (code: string | null, label: string): ColumnInfo =>
    columnInfo({ type: "ENUM", when_empty: { code, label } });

  it("shows the implied value for an empty field", () => {
    expect(renderValue(null, implied("0", "Regular")).text).toBe("Regular (0)");
  });

  it("marks it as implied rather than as something the feed contains", () => {
    const rendered = renderValue(null, implied("0", "Regular"));
    expect(rendered.implied).toBe("Empty. GTFS implies 0 - Regular.");
    expect(rendered.malformed).toBeUndefined();
    expect(rendered.href).toBeUndefined();
  });

  it("does not assume the implied code is 0", () => {
    // A blank pickup_type means 0 and a blank continuous_pickup beside it means
    // 1, which is why this is declared per field rather than per enumeration.
    expect(renderValue(null, implied("1", "Not Available")).text).toBe("Not Available (1)");
  });

  it("states a meaning that has no code", () => {
    // fare_attributes.transfers: empty means unlimited, which is not 0, 1 or 2.
    const rendered = renderValue(null, implied(null, "Unlimited transfers are permitted."));
    expect(rendered.text).toBe("Unlimited transfers are permitted.");
    expect(rendered.implied).toContain("Unlimited transfers");
  });

  it("shows nothing in raw mode, because the file contains nothing", () => {
    const rendered = renderValue(null, implied("0", "Regular"), true);
    expect(rendered.text).toBe("");
    expect(rendered.implied).toBeUndefined();
  });

  it("leaves a field GTFS says nothing about blank", () => {
    expect(renderValue(null, columnInfo({ type: "ENUM" })).text).toBe("");
    expect(renderValue(null, undefined).text).toBe("");
  });

  it("names the rule in the column header", () => {
    expect(describeColumn(implied("1", "Not Available"))).toBe(
      "ENUM · empty implies 1 - Not Available",
    );
  });
});

/**
 * Three types carried a pattern in schema/gtfs.yaml that no consumer could see,
 * because the generated document dropped every constraint. They are checked now
 * for the same reason Email is: the rule reaches the viewer.
 */
describe("types the schema now checks", () => {
  it.each([
    ["TIME", "08:30:00"],
    ["TIME", "25:30:00"], // past midnight, which GTFS explicitly allows
    ["TIME", "8:30:00"], // H:MM:SS, which the description accepts
    ["CURRENCY_CODE", "EUR"],
    ["TIMEZONE", "America/Argentina/Buenos_Aires"],
  ])("accepts %s %o", (type, value) => {
    expect(renderValue(value, column(type)).malformed).toBeUndefined();
  });

  it.each([
    ["TIME", "8:30"],
    ["TIME", "half past eight"],
    ["CURRENCY_CODE", "eur"],
    ["CURRENCY_CODE", "EURO"],
    ["TIMEZONE", "America/New York"],
  ])("flags %s %o", (type, value) => {
    const rendered = renderValue(value, column(type));
    expect(rendered.malformed).toBeTruthy();
    // Still the feed's own characters, as rule 1 of the module requires.
    expect(rendered.text).toBe(value);
  });

  it("explains a flagged value with GTFS's own definition of the type", () => {
    // No short wording is written for these, so the published description is
    // what the reader gets - rather than copy invented for the occasion.
    expect(renderValue("eur", column("CURRENCY_CODE")).malformed).toBe(
      "An ISO 4217 alphabetical currency code.",
    );
  });
});

/**
 * The pattern arrives from a document, not from this source file, so it has to
 * survive a document this build does not understand.
 */
describe("a pattern this build cannot use", () => {
  it("renders the value rather than throwing or blanking it", () => {
    const broken = columnInfo({ type: "TEXT", pattern: "([unclosed" });
    expect(renderValue("whatever the feed says", broken)).toEqual({
      text: "whatever the feed says",
      kind: "plain",
    });
  });

  it("still formats the type when the pattern is unusable", () => {
    // The check is skipped, not the rendering: a colour keeps its swatch.
    const broken = columnInfo({ type: "COLOR", pattern: "(" });
    expect(renderValue("FF0000", broken)).toMatchObject({ kind: "color", swatch: "#FF0000" });
  });
});
