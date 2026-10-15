/**
 * The data contract the UI depends on.
 *
 * The response shapes are generated from `docs/GtfsGarageAPI.yaml`, which is the
 * contract itself - the server's pydantic models come from the same document.
 * Aliased here rather than reached through `components["schemas"][…]`, so that
 * the rest of the viewer names a type the way it reads.
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
export type Workspace = Schemas["WorkspaceResponse"];
export type Overview = Schemas["OverviewResponse"];
export type OverviewAgency = Schemas["OverviewAgency"];
export type OverviewMode = Schemas["OverviewMode"];
export type FeedFeature = Schemas["FeedFeature"];
export type ServiceWindow = Schemas["ServiceWindow"];
export type CalendarSummary = Schemas["CalendarResponse"];
export type CalendarDay = Schemas["CalendarDay"];
export type ServicePattern = Schemas["ServicePattern"];
export type WeekdayProfile = Schemas["WeekdayProfile"];
export type RouteSummary = Schemas["RouteSummary"];
export type RouteDetail = Schemas["RouteDetailResponse"];
export type RouteDirection = Schemas["RouteDirection"];
export type RoutePattern = Schemas["RoutePattern"];
export type Timetable = Schemas["TimetableResponse"];
export type TimetableTrip = Schemas["TimetableTrip"];
export type TimetableCall = Schemas["TimetableCall"];
export type WorkspaceFeed = Schemas["WorkspaceFeed"];

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
   * The directory the source writes into, if it has one.
   *
   * All four are optional together and only a local GTFS Garage server has
   * them: they describe a process's own disk, which a hosted backend and a
   * browser reading Parquet have no equivalent of. The viewer builds the
   * workdir part of its options menu only when `workspace` is present, so an
   * implementation that omits these is not missing anything - there is simply
   * nothing to show.
   */
  /**
   * The derived views: the feed read as a network rather than as files.
   *
   * All four are optional together, and a source implements either all of them
   * or none. They are not a different kind of data - every figure is computed
   * from the rows `query` already serves - but computing them needs SQL the
   * browser-side Parquet source does not have, so the interface asks first and
   * shows the file browser alone when the answer is no.
   */
  /**
   * Whether this source can build the GeoJSON a map draws from.
   *
   * `geojson` is required, so its presence proves nothing - a source that
   * cannot draw a map implements it by rejecting, which is what `ParquetSource`
   * does. Setting this to false says so up front, so the viewer offers no map
   * action rather than one that fails at the first click. Absent means yes.
   */
  drawsGeometry?: boolean;
  overview?(): Promise<Overview>;
  calendar?(): Promise<CalendarSummary>;
  /** `serviceDate` narrows the list to the routes running that day. */
  routes?(serviceDate?: string): Promise<RouteSummary[]>;
  /** `serviceDate` adds what the route does on that one day. */
  route?(routeId: string, serviceDate?: string): Promise<RouteDetail>;
  /**
   * One route's departures on one day, as stops by trips.
   *
   * Optional **on its own**, unlike the four above which a source implements
   * together: it arrived later, and a source written against the earlier
   * contract keeps every view it had and simply does not offer this one.
   */
  timetable?(routeId: string, serviceDate: string, directionId?: string | null): Promise<Timetable>;
  workspace?(): Promise<Workspace>;
  /** Serve a feed the workdir already holds, without fetching it again. */
  reloadFeed?(id: string): Promise<TablesResponse>;
  /** Delete one feed's files. Refused while that feed is the one being served. */
  removeFeed?(id: string): Promise<Workspace>;
  /** Delete every feed's files but the one being served. */
  clearWorkspace?(): Promise<Workspace>;
  /**
   * Name the feed a new server on this workdir opens, or clear it with null.
   *
   * Separately optional from the four above: it is one control on a feed's
   * row, not the section itself, so a source written against the earlier
   * contract keeps its workdir and simply does not offer this.
   */
  setStartupFeed?(id: string | null): Promise<Workspace>;
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
