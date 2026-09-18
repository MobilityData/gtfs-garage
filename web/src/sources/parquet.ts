/**
 * A source that queries Parquet in the browser, with no server at all.
 *
 * A GTFS dataset is converted to Parquet once - `gtfs-garage --export`, and in
 * production the same conversion behind an API endpoint - and every table
 * becomes one file. DuckDB-WASM reads those over HTTP range requests, so a page
 * opens without downloading, unzipping or converting anything, and nothing has
 * to hold a feed in memory on anyone's behalf.
 *
 * The export writes through the same `ALL_VARCHAR` views the CSVs were read
 * with, so every column is text here exactly as it is server-side and the
 * filters below behave identically.
 */

import type {
  FeatureCollection,
  FileMetrics,
  LoadMetrics,
  Filter,
  GeoJsonKind,
  ViewerSource,
  PageResponse,
  TablesResponse,
  ValueCount,
} from "./types";
import { columnInfo, missingFiles, schemaTables } from "../schema";

/** The dataset's own description of itself, written by `gtfs-garage --export`. */
interface Manifest {
  version?: number;
  source?: { kind: string; bytes: number };
  totals?: { uncompressed_bytes: number; stored_bytes: number };
  tables?: {
    name: string;
    file?: string;
    rows?: number;
    columns?: number;
    bytes?: number | null;
    compressed_bytes?: number | null;
    parquet_bytes?: number;
  }[];
}

/**
 * Bytes actually fetched from the dataset, as the browser saw them.
 *
 * DuckDB fetches through its own path, so this is the only place the
 * transferred size is visible - and the honest number, since range requests
 * mean far less travels than the files weigh. Cross-origin entries report zero
 * unless the server sends `Timing-Allow-Origin`, so nothing is shown rather
 * than a zero that would read as "nothing was transferred".
 */
function transferred(baseUrl: string): string | undefined {
  if (typeof performance?.getEntriesByType !== "function") return undefined;
  const bytes = performance
    .getEntriesByType("resource")
    .filter((entry) => entry.name.includes(baseUrl))
    .reduce((total, entry) => total + ((entry as PerformanceResourceTiming).transferSize || 0), 0);
  return bytes > 0 ? `${Math.round(bytes / 1024)} kB fetched` : undefined;
}

type Connection = {
  query(sql: string): Promise<{ toArray(): Record<string, unknown>[] }>;
  close(): Promise<void>;
};

const MAPLESS = "ParquetSource cannot draw a map yet - mount without the map part.";

const OPERATORS = new Set(["eq", "ne", "contains", "in", "is_empty", "is_not_empty"]);

/**
 * A WHERE clause with its values inlined.
 *
 * Ported from `core/filters.py`, including the rule that matters most: an empty
 * CSV field loads as NULL, so `= (empty)` has to mean "is empty" or choosing
 * the `(empty)` entry in a picklist would match nothing.
 *
 * DuckDB-WASM's query API takes a string, so values are escaped rather than
 * bound. Every one is a string - the columns are all VARCHAR - and doubling
 * quotes is the whole of the escaping SQL needs for a string literal.
 */
export function buildWhere(known: string[], filters: Filter[]): string {
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const clauses: string[] = [];

  for (const filter of filters) {
    if (!known.includes(filter.column) || !OPERATORS.has(filter.op)) continue;
    const column = `"${filter.column}"`;
    const value = filter.value ?? "";

    let op: string = filter.op;
    if (op === "eq" && value === "") op = "is_empty";
    else if (op === "ne" && value === "") op = "is_not_empty";

    if (op === "eq") clauses.push(`${column} = ${literal(value)}`);
    else if (op === "ne") clauses.push(`${column} != ${literal(value)}`);
    else if (op === "contains") clauses.push(`${column} ILIKE ${literal(`%${value}%`)}`);
    else if (op === "is_empty") clauses.push(`(${column} IS NULL OR ${column} = '')`);
    else if (op === "is_not_empty") clauses.push(`(${column} IS NOT NULL AND ${column} != '')`);
    else if (op === "in") {
      const values = value.split(",").map((v) => v.trim()).filter(Boolean);
      if (values.length) clauses.push(`${column} IN (${values.map(literal).join(", ")})`);
    }
  }

  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

export interface ParquetSourceOptions {
  /** Where the `{table}.parquet` files live, without a trailing slash. */
  baseUrl: string;
  /** Shown as the feed's name in the header. */
  name?: string;
  /** Which tables the dataset has. Discovered by probing when not given. */
  tables?: string[];
}

export class ParquetSource implements ViewerSource {
  private connection: Connection | null = null;
  private terminate: (() => Promise<void>) | null = null;
  private present: Record<string, string[]> = {};
  private startupMs = 0;
  private manifestMs: number | null = null;
  private firstQueryMs = 0;

  constructor(private readonly options: ParquetSourceOptions) {}

  /** Release the worker and the wasm instance. See the viewer's `destroy`. */
  async close(): Promise<void> {
    await this.connection?.close();
    await this.terminate?.();
    this.connection = null;
    this.terminate = null;
  }

  /**
   * The file as an absolute URL.
   *
   * DuckDB runs in a worker and fetches these itself, so it has no page to
   * resolve a relative path against - `/datasets/x` reaches nothing. Callers
   * naturally write a path, so it is resolved here.
   */
  private file(table: string): string {
    const base = new URL(this.options.baseUrl, globalThis.location?.origin ?? "http://localhost");
    return `'${new URL(`${base.pathname.replace(/\/$/, "")}/${table}.parquet`, base.origin).href}'`;
  }

  /**
   * Start DuckDB on first use.
   *
   * Imported here rather than at the top of the file so that the megabytes of
   * wasm are fetched when a dataset is actually opened, not when the module is.
   */
  private async connect(): Promise<Connection> {
    if (this.connection) return this.connection;
    const started = performance.now();

    const duckdb = await import("@duckdb/duckdb-wasm");
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    // The worker comes from a CDN, so it is wrapped in a same-origin blob;
    // constructing a Worker from a cross-origin URL is blocked.
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker!}");`], { type: "text/javascript" }),
    );
    const worker = new Worker(workerUrl);
    const database = new duckdb.AsyncDuckDB(
      new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING),
      worker,
    );
    await database.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);

    this.terminate = () => database.terminate();
    this.connection = (await database.connect()) as unknown as Connection;
    // Megabytes of wasm and a worker: the dominant cost of opening a dataset,
    // and the one a reader waits on.
    this.startupMs = performance.now() - started;
    return this.connection;
  }

  /**
   * The table list an exported dataset carries, if it carries one.
   *
   * `gtfs-garage --export` writes it beside the Parquet. Absent, the only
   * fallback is probing every table GTFS defines.
   */
  private async fromManifest(): Promise<Manifest | null> {
    const started = performance.now();
    try {
      const response = await fetch(`${this.options.baseUrl}/manifest.json`);
      if (!response.ok) return null;
      const body = (await response.json()) as Manifest;
      this.manifestMs = performance.now() - started;
      // Version 1 recorded only a table list, and its `bytes` meant the Parquet
      // size rather than the source's - so its sizes are left out rather than
      // shown under headings that would misdescribe them.
      return (body.version ?? 1) >= 2 ? body : { version: 1, tables: body.tables };
    } catch {
      // No manifest is not an error: a dataset written by something else, or
      // served from somewhere that will not answer for it, still works.
      return null;
    }
  }

  /**
   * What the dataset cost to open *here*.
   *
   * The server's load report describes a download, an unzip and a conversion.
   * None of that happens in a browser reading Parquet: the cost is starting
   * DuckDB, fetching the manifest, and the first queries. Reporting the
   * conversion's timings instead would describe work this reader did not do.
   */
  private metrics(files: FileMetrics[], manifest: Manifest | null): LoadMetrics {
    const phases = [
      { label: "Start DuckDB", ms: this.startupMs, note: transferred(this.options.baseUrl) },
      ...(this.manifestMs === null ? [] : [{ label: "Read the manifest", ms: this.manifestMs }]),
      { label: "First query", ms: this.firstQueryMs },
    ];

    const stored = files.reduce((total, file) => total + (file.parquet_bytes ?? 0), 0);
    return {
      phases,
      // No `kind` and no zeroed timings: every server-load field is left out,
      // because none of that work happened here.
      total_ms: this.startupMs + (this.manifestMs ?? 0) + this.firstQueryMs,
      total_bytes: manifest?.totals?.uncompressed_bytes ?? stored,
      stored_bytes: stored,
      files,
    };
  }

  private async rows(sql: string): Promise<Record<string, unknown>[]> {
    const connection = await this.connect();
    return (await connection.query(sql)).toArray().map((row) => ({ ...row }));
  }

  async tables(): Promise<TablesResponse> {
    const startedAt = performance.now();
    const connection = await this.connect();

    const manifest = this.options.tables ? null : await this.fromManifest();
    const wanted =
      this.options.tables ?? manifest?.tables?.map((table) => table.name) ?? Object.keys(schemaTables);

    this.present = {};
    const failures: string[] = [];

    // Concurrently: without a table list this probes every file GTFS defines
    // and most will not be there.
    const probed = await Promise.all(
      wanted.map(async (table) => {
        try {
          const described = (
            await connection.query(`DESCRIBE SELECT * FROM ${this.file(table)}`)
          ).toArray();
          const counted = await connection.query(`SELECT count(*) AS n FROM ${this.file(table)}`);
          return {
            table,
            columns: described.map((row) => String(row.column_name)),
            rowCount: Number(counted.toArray()[0].n),
          };
        } catch (error) {
          // Ordinarily just an optional file the feed did not have. Kept
          // because *every* table failing means something else - see below.
          failures.push((error as Error).message);
          return null;
        }
      }),
    );

    const summaries = probed.filter((entry) => entry !== null);
    for (const entry of summaries) this.present[entry.table] = entry.columns;

    if (!summaries.length) {
      // A GTFS feed has agency.txt, routes.txt, trips.txt and stop_times.txt at
      // minimum, so nothing readable at all means a wrong location or a
      // dataset not yet written - not a feed with no files.
      // A GTFS feed has agency, routes, trips and stop_times at minimum, so
      // nothing readable at all is a wrong location or a dataset that has not
      // been written yet - not a feed with no files.
      throw new Error(
        `No tables found at ${this.options.baseUrl}. Pass the dataset's table list to skip probing, ` +
          `and check the dataset exists. First reason: ${failures[0] ?? "nothing probed"}`,
      );
    }

    this.firstQueryMs = performance.now() - startedAt - this.startupMs - (this.manifestMs ?? 0);

    // The per-file rows come from the manifest, which recorded what each file
    // weighed before conversion - sizes the dataset no longer carries.
    const described = new Map((manifest?.tables ?? []).map((table) => [table.name, table]));
    const files: FileMetrics[] = summaries.map((entry) => {
      const facts = described.get(entry.table);
      return {
        name: facts?.file ?? `${entry.table}.parquet`,
        table: entry.table,
        bytes: facts?.bytes ?? facts?.parquet_bytes ?? 0,
        compressed_bytes: facts?.compressed_bytes ?? null,
        register_ms: 0,
        convert_ms: null,
        parquet_bytes: facts?.parquet_bytes ?? null,
        count_ms: null,
        row_count: entry.rowCount,
        columns: entry.columns.length,
      };
    });

    return {
      metrics: this.metrics(files, manifest),
      source: this.options.name ?? this.options.baseUrl,
      tables: summaries.map(({ table, columns, rowCount }) => ({
        name: table,
        row_count: rowCount,
        columns: columns.map((column) => columnInfo(table, column, this.present)),
        forbidden: null,
      })),
      missing: missingFiles(this.present),
    };
  }

  async query(table: string, filters: Filter[], page: number, pageSize: number): Promise<PageResponse> {
    const columns = this.present[table] ?? [];
    const where = buildWhere(columns, filters);
    const counted = await this.rows(`SELECT count(*) AS n FROM ${this.file(table)} ${where}`);
    const list = columns.map((c) => `"${c}"`).join(", ");
    const rows = await this.rows(
      `SELECT ${list} FROM ${this.file(table)} ${where} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    );

    return {
      columns,
      // Every value is text or null, as it is server-side; the viewer formats
      // from the schema and must never receive a number it did not ask for.
      rows: rows.map((row) => columns.map((c) => (row[c] == null ? null : String(row[c])))),
      total: Number(counted[0].n),
      page,
      page_size: pageSize,
    };
  }

  async distinct(table: string, column: string, limit = 200): Promise<ValueCount[]> {
    const rows = await this.rows(
      `SELECT "${column}" AS value, count(*) AS n FROM ${this.file(table)}
       GROUP BY 1 ORDER BY 2 DESC LIMIT ${limit}`,
    );
    return rows.map((row) => ({
      value: row.value == null ? null : String(row.value),
      count: Number(row.n),
    }));
  }

  // Reached only if the viewer is mounted with a map, which this source does not
  // support yet - building GeoJSON means porting the layer building, the vertex
  // budget and the thinning that `core/geojson.py` does. Both throw rather than
  // return nothing, which would look like a feed with no stops.
  geojson(_kind: GeoJsonKind, _ids?: string[]): Promise<FeatureCollection> {
    return Promise.reject(new Error(MAPLESS));
  }

  geojsonStream(_kind: GeoJsonKind, _onMessage: unknown, _signal?: AbortSignal): Promise<void> {
    return Promise.reject(new Error(MAPLESS));
  }
}
