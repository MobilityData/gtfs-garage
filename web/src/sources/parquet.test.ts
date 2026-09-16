import { describe, expect, it } from "vitest";

import { buildWhere } from "./parquet";
import type { Filter, FilterOperator } from "./types";

/**
 * Ported from `tests/test_filters.py`, because the browser source and the
 * Python one have to answer a filter the same way or the same feed reads
 * differently depending on where it is opened.
 */
describe("buildWhere", () => {
  const columns = ["stop_id", "stop_name"];
  const filter = (op: FilterOperator, value?: string): Filter[] => [{ column: "stop_id", op, value }];

  it("returns nothing for no filters", () => {
    expect(buildWhere(columns, [])).toBe("");
  });

  it("ignores a column the table does not have", () => {
    expect(buildWhere(columns, [{ column: "not_a_column", op: "eq", value: "x" }])).toBe("");
  });

  it("ignores an operator it does not know", () => {
    // Cast because the type forbids it; a source could still be handed one by
    // a caller that is not type-checked, and it must not reach the SQL.
    expect(buildWhere(columns, [{ column: "stop_id", op: "regex" as FilterOperator, value: "x" }])).toBe("");
  });

  it.each([
    ["eq", "ST1", `WHERE "stop_id" = 'ST1'`],
    ["ne", "ST1", `WHERE "stop_id" != 'ST1'`],
    ["contains", "ST", `WHERE "stop_id" ILIKE '%ST%'`],
  ] as [FilterOperator, string, string][])("builds %s", (op, value, expected) => {
    expect(buildWhere(columns, filter(op, value))).toBe(expected);
  });

  /**
   * The rule that matters most: an empty CSV field loads as NULL, so `= (empty)`
   * has to mean "is empty" or picking `(empty)` out of a picklist matches
   * nothing at all.
   */
  it("turns equals-empty into an emptiness test", () => {
    expect(buildWhere(columns, filter("eq", ""))).toBe(`WHERE ("stop_id" IS NULL OR "stop_id" = '')`);
    expect(buildWhere(columns, filter("ne", ""))).toBe(`WHERE ("stop_id" IS NOT NULL AND "stop_id" != '')`);
  });

  it("splits an in-list and drops the blanks", () => {
    expect(buildWhere(columns, filter("in", "A, B ,,C"))).toBe(`WHERE "stop_id" IN ('A', 'B', 'C')`);
    expect(buildWhere(columns, filter("in", " , "))).toBe("");
  });

  it("joins several filters with AND", () => {
    const filters: Filter[] = [
      { column: "stop_id", op: "eq", value: "ST1" },
      { column: "stop_name", op: "contains", value: "First" },
    ];
    expect(buildWhere(columns, filters)).toBe(`WHERE "stop_id" = 'ST1' AND "stop_name" ILIKE '%First%'`);
  });

  /**
   * Values are escaped rather than bound, because DuckDB-WASM's query API takes
   * a string. Every column is text, so doubling quotes is the whole of it - but
   * getting it wrong would be an injection into the user's own database.
   */
  it("escapes a quote rather than ending the literal", () => {
    expect(buildWhere(columns, filter("eq", "O'Hare"))).toBe(`WHERE "stop_id" = 'O''Hare'`);
    expect(buildWhere(columns, filter("eq", "'; DROP TABLE stops; --"))).toBe(
      `WHERE "stop_id" = '''; DROP TABLE stops; --'`,
    );
  });
});
