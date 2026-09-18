/**
 * The packaged GTFS description, for code that has no server to ask.
 *
 * The REST source gets every column's type, keys and conditions from the API,
 * which reads this same document in Python. A source querying Parquet in the
 * browser has nobody to ask, so it reads the document directly and builds the
 * same `ColumnInfo` from it.
 */

import document from "../../src/gtfs_garage/data/gtfs-schema.json";
import type { ColumnInfo, MissingFile, RelatedLink } from "./sources/types";

interface Field {
  type?: string;
  values?: Record<string, string>;
  required?: string;
  condition?: string;
  conditionScope?: string;
  primaryKey?: boolean;
  references?: { table: string; field: string };
  whenEmpty?: { code?: string | null; label: string };
}

interface Table {
  presence?: string;
  condition?: string;
  fields: Record<string, Field>;
}

interface FieldType {
  description: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
}

const TABLES = document.tables as unknown as Record<string, Table>;
const FIELD_TYPES = document.fieldTypes as unknown as Record<string, FieldType>;
const ENUM_LIKE = new Set(document.enumLikeColumns as string[]);

/** The column holding each table's own id, for the reverse links below. */
const PRIMARY_ID = Object.fromEntries(
  Object.entries(TABLES)
    .map(([table, entry]) => [table, Object.entries(entry.fields).find(([, f]) => f.primaryKey)?.[0]])
    .filter(([, column]) => column),
) as Record<string, string>;

/**
 * Every (table, column) whose foreign key points at this table's id - what the
 * viewer offers as "show related rows". Mirrors `core/schema.py:related_tables`.
 */
function relatedTables(table: string): RelatedLink[] {
  const id = PRIMARY_ID[table];
  if (!id) return [];
  const links: RelatedLink[] = [];
  for (const [other, entry] of Object.entries(TABLES)) {
    for (const [column, field] of Object.entries(entry.fields)) {
      const reference = field.references;
      if (reference?.table === table && reference.field === id) links.push({ table: other, column });
    }
  }
  return links;
}

/**
 * What the schema says about one column, in the shape the UI consumes.
 *
 * `present` is the tables this feed actually has: a link is only offered when
 * its target is there, which is the same rule the REST source applies.
 */
export function columnInfo(table: string, column: string, present: Record<string, string[]>): ColumnInfo {
  const field = TABLES[table]?.fields[column] ?? {};
  const shape = FIELD_TYPES[field.type ?? ""];
  const reference = field.references;
  const resolves = reference && present[reference.table]?.includes(reference.field);
  const isPrimary = Object.entries(TABLES[table]?.fields ?? {}).find(([, f]) => f.primaryKey)?.[0] === column;

  return {
    name: column,
    fk_table: resolves ? reference.table : null,
    fk_column: resolves ? reference.field : null,
    enum_like: ENUM_LIKE.has(column),
    related: isPrimary ? relatedTables(table).filter((l) => present[l.table]?.includes(l.column)) : [],
    type: field.type ?? null,
    values: field.values ?? null,
    required: field.required ?? null,
    condition: field.condition ?? null,
    condition_scope: field.conditionScope ?? null,
    // Feed-scope conditions are answered by counting rows and reading file
    // lists. Left unanswered here rather than guessed: the viewer falls back to
    // stating the condition, which is what it does for any unanswerable one.
    condition_outcome: null,
    when_empty: field.whenEmpty ? { code: field.whenEmpty.code ?? null, label: field.whenEmpty.label } : null,
    pattern: shape?.pattern ?? null,
    minimum: shape?.minimum ?? null,
    maximum: shape?.maximum ?? null,
    type_description: shape?.description ?? null,
  };
}

/** Files GTFS requires that this feed does not have. */
export function missingFiles(present: Record<string, string[]>): MissingFile[] {
  return Object.entries(TABLES)
    .filter(([table, entry]) => entry.presence === "required" && !(table in present))
    .map(([table, entry]) => ({
      name: table,
      presence: "required",
      condition: entry.condition ?? null,
      condition_outcome: null,
    }));
}

export { TABLES as schemaTables };
