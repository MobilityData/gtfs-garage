/** `GtfsSource` backed by the local Python server. */

import { readNdjson, type NdjsonMessage } from "./ndjson";
import type {
  AppConfig,
  CalendarSummary,
  FeatureCollection,
  Filter,
  GeoJsonKind,
  GtfsSource,
  LoadProgress,
  Overview,
  PageResponse,
  RouteDetail,
  RouteSummary,
  TablesResponse,
  Timetable,
  ValueCount,
  Workspace,
} from "./types";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}) as { detail?: string });
    throw new HttpError(
      body.detail ?? `${response.status} ${response.statusText}`,
      response.status,
    );
  }
  return response.json() as Promise<T>;
}

/** What each layer calls its ids. Routes are highlighted through their shape. */
const ID_PARAMS: Record<GeoJsonKind, string> = {
  stops: "stop_ids",
  shapes: "shape_ids",
  routes: "shape_ids",
  locations: "location_ids",
};

export class RestSource implements GtfsSource {
  constructor(private readonly baseUrl = "") {}

  config(): Promise<AppConfig> {
    return fetchJson<AppConfig>(`${this.baseUrl}/api/config`);
  }

  tables(): Promise<TablesResponse> {
    return fetchJson<TablesResponse>(`${this.baseUrl}/api/tables`);
  }

  query(
    table: string,
    filters: Filter[],
    page: number,
    pageSize: number,
  ): Promise<PageResponse> {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      filters: JSON.stringify(filters),
    });
    return fetchJson<PageResponse>(
      `${this.baseUrl}/api/table/${encodeURIComponent(table)}?${params}`,
    );
  }

  async distinct(table: string, column: string, limit = 100): Promise<ValueCount[]> {
    const { values } = await fetchJson<{ values: ValueCount[] }>(
      `${this.baseUrl}/api/table/${encodeURIComponent(table)}/distinct/${encodeURIComponent(column)}?limit=${limit}`,
    );
    return values;
  }

  geojson(kind: GeoJsonKind, ids?: string[]): Promise<FeatureCollection> {
    const params = new URLSearchParams();
    // One parameter per id rather than a delimited list: a GTFS id is any UTF-8
    // string and may contain a comma, which a delimiter splits into two ids
    // that match nothing.
    for (const id of ids ?? []) params.append(ID_PARAMS[kind], id);
    const query = params.toString();
    return fetchJson<FeatureCollection>(
      `${this.baseUrl}/api/geojson/${kind}${query ? `?${query}` : ""}`,
    );
  }

  overview(): Promise<Overview> {
    return fetchJson<Overview>(`${this.baseUrl}/api/overview`);
  }

  calendar(): Promise<CalendarSummary> {
    return fetchJson<CalendarSummary>(`${this.baseUrl}/api/calendar`);
  }

  async routes(serviceDate?: string): Promise<RouteSummary[]> {
    const query = serviceDate ? `?service_date=${encodeURIComponent(serviceDate)}` : "";
    const { routes } = await fetchJson<{ routes: RouteSummary[] }>(`${this.baseUrl}/api/routes${query}`);
    return routes;
  }

  timetable(routeId: string, serviceDate: string, directionId?: string | null): Promise<Timetable> {
    const params = new URLSearchParams({ service_date: serviceDate });
    if (directionId !== undefined && directionId !== null) params.set("direction_id", directionId);
    return fetchJson<Timetable>(
      `${this.baseUrl}/api/routes/${encodeURIComponent(routeId)}/timetable?${params}`,
    );
  }

  route(routeId: string, serviceDate?: string): Promise<RouteDetail> {
    // Encoded per segment: a GTFS id is any UTF-8 string, and the server reads
    // this path parameter as a `:path` so an id containing a slash survives.
    const query = serviceDate ? `?service_date=${encodeURIComponent(serviceDate)}` : "";
    return fetchJson<RouteDetail>(`${this.baseUrl}/api/routes/${encodeURIComponent(routeId)}${query}`);
  }

  workspace(): Promise<Workspace> {
    return fetchJson<Workspace>(`${this.baseUrl}/api/workspace`);
  }

  reloadFeed(id: string): Promise<TablesResponse> {
    return fetchJson<TablesResponse>(
      `${this.baseUrl}/api/workspace/feeds/${encodeURIComponent(id)}/reload`,
      { method: "POST" },
    );
  }

  removeFeed(id: string): Promise<Workspace> {
    return fetchJson<Workspace>(
      `${this.baseUrl}/api/workspace/feeds/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }

  clearWorkspace(): Promise<Workspace> {
    return fetchJson<Workspace>(`${this.baseUrl}/api/workspace`, { method: "DELETE" });
  }

  setStartupFeed(id: string | null): Promise<Workspace> {
    return fetchJson<Workspace>(`${this.baseUrl}/api/workspace/startup`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feed_id: id }),
    });
  }

  loadProgress(): Promise<LoadProgress> {
    return fetchJson<LoadProgress>(`${this.baseUrl}/api/load/progress`);
  }

  /**
   * Stream a whole layer, one batch at a time.
   *
   * Used instead of `geojson` for the full-feed layers: a large feed runs to
   * hundreds of MB, which is neither transferable nor parseable in one piece.
   */
  async geojsonStream(
    kind: GeoJsonKind,
    onMessage: (message: NdjsonMessage) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/geojson/${kind}`, { signal });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}) as { detail?: string });
      throw new HttpError(
        body.detail ?? `${response.status} ${response.statusText}`,
        response.status,
      );
    }
    if (!response.body) throw new Error("This browser cannot stream responses.");
    await readNdjson(response.body, onMessage);
  }

  /**
   * Load a feed: an uploaded zip, a chosen folder's files, a local path, or a
   * URL for the server to download.
   */
  load(input: {
    path?: string;
    url?: string;
    file?: File;
    files?: File[];
    name?: string;
  }): Promise<TablesResponse> {
    if (input.files?.length) {
      const form = new FormData();
      for (const file of input.files) form.append("files", file);
      const query = input.name ? `?name=${encodeURIComponent(input.name)}` : "";
      return fetchJson<TablesResponse>(`${this.baseUrl}/api/load${query}`, {
        method: "POST",
        body: form,
      });
    }

    if (input.file) {
      const form = new FormData();
      form.append("file", input.file);
      return fetchJson<TablesResponse>(`${this.baseUrl}/api/load`, {
        method: "POST",
        body: form,
      });
    }

    const params = new URLSearchParams();
    if (input.url) params.set("url", input.url);
    else params.set("path", input.path ?? "");

    return fetchJson<TablesResponse>(`${this.baseUrl}/api/load?${params}`, { method: "POST" });
  }
}
