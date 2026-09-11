/**
 * The data contract the UI depends on.
 *
 * These types mirror the pydantic models in src/gtfs_garage/server/models.py,
 * which FastAPI publishes as OpenAPI. Any implementation of `GtfsSource` can
 * drive the UI: `RestSource` talks to the local Python server, and a future
 * DuckDB-WASM implementation could read Parquet over HTTP range requests
 * without the UI knowing the difference.
 */

export interface RelatedLink {
  table: string;
  column: string;
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
}

export interface TableInfo {
  name: string;
  row_count: number;
  columns: ColumnInfo[];
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
  count_ms: number;
  /** The phases above added together. */
  total_ms: number;
  /** The zip's size, or the sum of the .txt files in a folder. */
  total_bytes: number;
  files: FileMetrics[];
}

export interface TablesResponse {
  source: string;
  tables: TableInfo[];
  metrics: LoadMetrics;
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

export type GeoJsonKind = "stops" | "shapes" | "routes";

export interface FeatureCollection {
  type: "FeatureCollection";
  features: GeoFeature[];
}

export interface GeoFeature {
  type: "Feature";
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, string>;
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
