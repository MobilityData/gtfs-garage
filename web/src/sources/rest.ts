/** `GtfsSource` backed by the local Python server. */

import { readNdjson, type NdjsonMessage } from "./ndjson";
import type {
  AppConfig,
  FeatureCollection,
  Filter,
  GeoJsonKind,
  GtfsSource,
  LoadProgress,
  PageResponse,
  TablesResponse,
  ValueCount,
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
    if (ids?.length) {
      params.set(kind === "stops" ? "stop_ids" : "shape_ids", ids.join(","));
    }
    const query = params.toString();
    return fetchJson<FeatureCollection>(
      `${this.baseUrl}/api/geojson/${kind}${query ? `?${query}` : ""}`,
    );
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
