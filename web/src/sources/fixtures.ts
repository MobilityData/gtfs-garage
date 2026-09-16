/**
 * Test fixtures for the data contract.
 *
 * `ColumnInfo` gains a field whenever the schema learns to describe one more
 * thing about a column, and every inline literal in a test breaks when it does.
 * Building them here means a new field has one default to add, not one per test.
 */

import schema from "../../../src/gtfs_garage/data/gtfs-schema.json";
import type { ColumnInfo, TableInfo } from "./types";

interface PublishedType {
  description: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
}

const FIELD_TYPES = schema.fieldTypes as Record<string, PublishedType>;

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
    condition_scope: null,
    condition_outcome: null,
    when_empty: null,
    pattern: null,
    minimum: null,
    maximum: null,
    type_description: null,
    ...overrides,
  };
}

/**
 * A column of a given GTFS field type, carrying what the schema publishes for
 * it.
 *
 * Reads the generated document rather than repeating its patterns here, so a
 * test asserting that an address is rejected exercises the rule the application
 * ships instead of a copy that could drift from it. This is the same resolution
 * `queries.py` performs server-side.
 */
export function typedColumn(type: string, overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  const shape = FIELD_TYPES[type] ?? { description: "" };
  return columnInfo({
    type,
    pattern: shape.pattern ?? null,
    minimum: shape.minimum ?? null,
    maximum: shape.maximum ?? null,
    type_description: shape.description || null,
    ...overrides,
  });
}

export function tableInfo(overrides: Partial<TableInfo> = {}): TableInfo {
  return {
    name: "table",
    row_count: 0,
    columns: [],
    forbidden: null,
    ...overrides,
  };
}
