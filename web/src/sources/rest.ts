/** `GtfsSource` backed by the local Python server. */

import type {
  FeatureCollection,
  Filter,
  GeoJsonKind,
  GtfsSource,
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

  /** Load a feed by local path or uploaded file; returns the new table list. */
  load(input: { path?: string; file?: File }): Promise<TablesResponse> {
    if (input.file) {
      const form = new FormData();
      form.append("file", input.file);
      return fetchJson<TablesResponse>(`${this.baseUrl}/api/load`, {
        method: "POST",
        body: form,
      });
    }
    return fetchJson<TablesResponse>(
      `${this.baseUrl}/api/load?path=${encodeURIComponent(input.path ?? "")}`,
      { method: "POST" },
    );
  }
}
