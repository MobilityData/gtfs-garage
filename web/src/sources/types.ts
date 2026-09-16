/**
 * The data contract the UI depends on.
 *
 * These types mirror the pydantic models in src/gtfs_garage/server/models.py,
 * which FastAPI publishes as OpenAPI. Any implementation of `GtfsSource` can
 * drive the UI: `RestSource` talks to the local Python server, and a future
 * DuckDB-WASM implementation could read Parquet over HTTP range requests
 * without the UI knowing the difference.
 */

import type { NdjsonMessage } from "./ndjson";

export interface RelatedLink {
  table: string;
  column: string;
}

/**
 * What GTFS says an empty value means for a field.
 *
 * `code` is one of the field's own enum codes - "0 or empty - Regularly
 * scheduled pickup" - and is null only where the implied meaning has no code,
 * as for `fare_attributes.transfers`, whose empty value means unlimited
 * transfers.
 */
export interface ImpliedValue {
  code: string | null;
  label: string;
}

/**
 * Whether a feed-scope condition holds in the feed now loaded. `evidence` is
 * what the check counted to decide - "3 agencies" - so the answer can be read
 * back rather than trusted.
 */
export interface ConditionOutcome {
  holds: boolean;
  evidence: string;
}

export interface ColumnInfo {
  name: string;
  /** Set only when the referenced table and column exist in this feed. */
  fk_table: string | null;
  fk_column: string | null;
  /** GTFS defines a small fixed value set, so offer a picklist. */
  enum_like: boolean;
  /** Always present; empty unless this column is its table's primary id. */
  related: RelatedLink[];
  /**
   * What GTFS says the field holds - ID, ENUM, COLOR, LATITUDE, DATE and so on.
   * Null for a column the schema does not describe, such as a producer's own
   * extension column, which renders as text.
   */
  type: string | null;
  /** For an enumeration, its codes and their labels; null otherwise. */
  values: Record<string, string> | null;
  /** "always", "conditional", or null where GTFS makes the field optional. */
  required: string | null;
  /**
   * For a conditionally required field, the condition in words - "Required if
   * route_long_name is empty." Null otherwise.
   */
  condition: string | null;
  /**
   * What decides the condition: "row" where the row settles it, "feed" where
   * the feed as a whole does, "row_context" where it varies row by row and the
   * row does not carry what decides it. Null unless the field is conditional.
   */
  condition_scope: string | null;
  /**
   * The answer for this feed, for a "feed" scope. Null for any other scope, and
   * null when the check could not run.
   */
  condition_outcome: ConditionOutcome | null;
  /** What an empty value implies, where GTFS defines it. Null otherwise. */
  when_empty: ImpliedValue | null;
  /**
   * What a value of this field's type must look like, from the schema's
   * `fieldTypes`. The rule is declared there rather than here so there is one
   * copy of it; all four are null for a type GTFS states no format for.
   */
  pattern: string | null;
  minimum: number | null;
  maximum: number | null;
  /** GTFS's own definition of the type, for when a value does not match it. */
  type_description: string | null;
}

/**
 * Why GTFS says this feed should not contain this file. The counterpart to
 * `MissingFile`: that one is absent and needed, this one present and not wanted.
 */
export interface FileCondition {
  condition: string;
  outcome: ConditionOutcome;
}

export interface TableInfo {
  name: string;
  row_count: number;
  columns: ColumnInfo[];
  /** Set only where GTFS forbids this file and the condition holds here. */
  forbidden: FileCondition | null;
}

/** What one .txt file cost to open. */
export interface FileMetrics {
  name: string;
  table: string;
  /** Uncompressed size on disk. */
  bytes: number;
  /** Only for zip sources; a chosen folder has no compressed form. */
  compressed_bytes: number | null;
  /** Declaring the DuckDB view. Views are lazy, so this is near zero. */
  register_ms: number;
  /** Rewriting this table as Parquet; null when opened with --no-parquet. */
  convert_ms: number | null;
  /** What the table occupies once converted, usually far below `bytes`. */
  parquet_bytes: number | null;
  /** The COUNT(*) that actually scans the file - the real read cost. */
  count_ms: number | null;
  row_count: number | null;
  columns: number;
}

/** Server-side sizes and timings for the feed currently loaded. */
export interface LoadMetrics {
  /** How the feed reached the server. */
  kind: "path" | "upload" | "folder" | "download";
  /** Downloading or receiving the upload; null for a local path. */
  acquire_ms: number | null;
  acquire_bytes: number | null;
  /** Unzipping; null when the source was already-extracted files. */
  extract_ms: number | null;
  register_ms: number;
  /** Converting to Parquet; null when opened with --no-parquet. */
  convert_ms: number | null;
  count_ms: number;
  /** The phases above added together. */
  total_ms: number;
  /** The zip's size, or the sum of the .txt files in a folder. */
  total_bytes: number;
  /** What the feed occupies to query once converted; null when it was not. */
  stored_bytes: number | null;
  files: FileMetrics[];
}

/** Where a running load has got to, polled while the load is in flight. */
export interface LoadProgress {
  phase: "start" | "download" | "upload" | "extract" | "convert" | "summarise" | "done";
  done: number;
  /** 0 when the total is not knowable, e.g. a download with no Content-Length. */
  total: number;
  detail: string;
  running: boolean;
}

/**
 * A file the feed does not have and needs - required, or conditionally required
 * with the condition holding here. Files it merely could have are not listed.
 */
export interface MissingFile {
  name: string;
  presence: string;
  condition: string | null;
  condition_outcome: ConditionOutcome | null;
}

export interface TablesResponse {
  source: string;
  tables: TableInfo[];
  missing: MissingFile[];
  /**
   * What the feed cost to open. Absent for a source with no load to report -
   * a browser reading Parquet did not download, unzip or convert anything.
   */
  metrics?: LoadMetrics;
}

/** Row values are strings or null: every column is read as text. */
export type Row = (string | null)[];

export interface PageResponse {
  columns: string[];
  rows: Row[];
  total: number;
  page: number;
  page_size: number;
}

/** `value: null` means the field is empty in the feed. */
export interface ValueCount {
  value: string | null;
  count: number;
}

export type FilterOperator =
  | "eq"
  | "ne"
  | "contains"
  | "in"
  | "is_empty"
  | "is_not_empty";

export interface Filter {
  column: string;
  op: FilterOperator;
  value?: string;
}

export interface AppConfig {
  /** Preset name, raster tile template, or vector style URL. */
  basemap: string;
  version: string;
}

export type GeoJsonKind = "stops" | "shapes" | "routes" | "locations";

export interface FeatureCollection {
  type: "FeatureCollection";
  features: GeoFeature[];
}

export interface GeoFeature {
  type: "Feature";
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, string>;
}

/**
 * What a whole viewer needs, which is more than a table needs.
 *
 * `GtfsSource` answers the table. The map additionally streams, because a large
 * feed's shapes arrive over seconds and are drawn as they land rather than all
 * at the end - so a host supplying its own source implements this, not just
 * `GtfsSource`. `config` is optional: it exists on the REST source, where the
 * basemap is a server setting, and a host that passes `basemap` needs neither.
 */
export interface ViewerSource extends GtfsSource {
  geojsonStream(
    kind: GeoJsonKind,
    onMessage: (message: NdjsonMessage) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  config?(): Promise<AppConfig>;
}

export interface GtfsSource {
  tables(): Promise<TablesResponse>;
  query(
    table: string,
    filters: Filter[],
    page: number,
    pageSize: number,
  ): Promise<PageResponse>;
  distinct(table: string, column: string, limit?: number): Promise<ValueCount[]>;
  geojson(kind: GeoJsonKind, ids?: string[]): Promise<FeatureCollection>;
}
