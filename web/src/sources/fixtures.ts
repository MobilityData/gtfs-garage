/**
 * Test fixtures for the data contract.
 *
 * `ColumnInfo` gains a field whenever the schema learns to describe one more
 * thing about a column, and every inline literal in a test breaks when it does.
 * Building them here means a new field has one default to add, not one per test.
 */

import type { ColumnInfo } from "./types";

export function columnInfo(overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name: "field",
    fk_table: null,
    fk_column: null,
    enum_like: false,
    related: [],
    type: null,
    values: null,
    required: null,
    condition: null,
    ...overrides,
  };
}
