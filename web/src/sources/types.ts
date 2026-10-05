/**
 * The data contract the UI depends on.
 *
 * The response shapes are generated from `docs/GtfsGarageAPI.yaml`, which is the
 * contract itself - the server's pydantic models come from the same document.
 * They were previously written out here by hand and kept in step with
 * `server/models.py` by reading both, which is a thing nobody does reliably.
 * Aliased rather than used through `components["schemas"][…]` so that every
 * import across the viewer reads the same as it always has.
 *
 * What stays hand-written below is the part no HTTP document can describe: the
 * interfaces a source implements. `RestSource` talks to a GTFS Garage server and
 * `ParquetSource` reads Parquet in the browser over range requests, and the UI
 * cannot tell which it has.
 *
 * Regenerate with `scripts/api-gen.sh`.
 */

import type { components } from "./api.gen";
import type { NdjsonMessage } from "./ndjson";

type Schemas = components["schemas"];

export type RelatedLink = Schemas["RelatedLink"];
export type ImpliedValue = Schemas["ImpliedValue"];
export type ConditionOutcome = Schemas["ConditionOutcome"];
export type ColumnInfo = Schemas["ColumnInfo"];
export type FileCondition = Schemas["FileCondition"];
export type MissingFile = Schemas["MissingFile"];
export type TableInfo = Schemas["TableInfo"];
export type FileMetrics = Schemas["FileMetrics"];
export type LoadMetrics = Schemas["LoadMetrics"];
export type LoadProgress = Schemas["LoadProgress"];
export type TablesResponse = Schemas["TablesResponse"];
export type PageResponse = Schemas["PageResponse"];
export type ValueCount = Schemas["ValueCount"];
export type FilterOperator = Schemas["FilterOperator"];
export type Filter = Schemas["Filter"];
export type AppConfig = Schemas["ConfigResponse"];
export type GeoFeature = Schemas["Feature"];
export type FeatureCollection = Schemas["FeatureCollection"];
export type DatasetManifest = Schemas["DatasetManifest"];

/** Row values are strings or null: every column is read as text. */
export type Row = (string | null)[];

/**
 * Which map layer. Not in the spec as a type: it is a path segment there, and
 * the four paths exist separately because each takes its own id parameter.
 */
export type GeoJsonKind = "stops" | "shapes" | "routes" | "locations";

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
  /**
   * Release whatever the source is holding.
   *
   * A REST source holds nothing; one querying Parquet holds a WebAssembly
   * instance and a worker, and browsers allow only a handful. Whoever created
   * the source calls this - so `mountDataset` closes the source its provider
   * handed it, while `mount` leaves a caller-supplied one alone, because the
   * caller may be reusing it.
   */
  close?(): Promise<void>;
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
