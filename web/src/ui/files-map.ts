/**
 * The map in Files mode: what the current view selects, and nothing else.
 *
 * The same principle the Explore screens keep - a route drawn among every
 * other route in the city is not shown, it is hidden - applied to the file
 * browser. A view filtered to `route_id = 2` is about route 2, so the map shows
 * route 2; a row's map button picks out that row's stop, shape or route. The
 * rest of the network is off until asked for, and with nothing selected the
 * whole network is drawn as before.
 */

import { PALE_ROUTE_COLOR, routeLineColor } from "../map/layers";
import type { MapHandle } from "../mount";
import type { FeatureCollection, Filter, PageResponse, ViewerSource } from "../sources/types";

/** What a Files view puts on the map. */
export interface MapSelection {
  routeIds: string[];
  shapeIds: string[];
  stopIds: string[];
}

/** The columns that name something the map can draw, and where each goes. */
const DRAWN_COLUMNS: Record<string, keyof MapSelection> = {
  route_id: "routeIds",
  shape_id: "shapeIds",
  stop_id: "stopIds",
};

/**
 * What a view's filters select, or null when they select nothing drawable.
 *
 * Only filters that pin a column to values - `is` and `is one of` - count.
 * `is not` or `contains` narrow the rows without naming a thing to draw, and
 * drawing everything they leave would be drawing the network again. Read from
 * the column name alone, so `route_id = 2` selects route 2 in trips.txt and in
 * routes.txt alike.
 */
export function selectionFromFilters(filters: Filter[]): MapSelection | null {
  const picked: MapSelection = { routeIds: [], shapeIds: [], stopIds: [] };
  for (const filter of filters) {
    const key = DRAWN_COLUMNS[filter.column];
    if (!key || !filter.value) continue;
    if (filter.op === "eq") picked[key].push(filter.value);
    else if (filter.op === "in") {
      picked[key].push(
        ...filter.value
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      );
    }
  }
  const unique = {
    routeIds: [...new Set(picked.routeIds)],
    shapeIds: [...new Set(picked.shapeIds)],
    stopIds: [...new Set(picked.stopIds)],
  };
  return unique.routeIds.length || unique.shapeIds.length || unique.stopIds.length ? unique : null;
}

/**
 * Most rows a filter may leave for the map to draw what they reference.
 *
 * The rows are read through the table query, whose pages stop at 500. A
 * filter leaving more - every bus trip in a city - is drawn as the network
 * rather than as whichever 500 came first, which would be a map of an
 * accident of ordering.
 */
export const ROW_LIMIT = 500;

/**
 * Most routes drawn from their own shapes and stops.
 *
 * Each costs a request for the route's description. Beyond a handful the
 * routes layer's one line per route draws them instead - every route still
 * shown, without a hundred requests behind a filter on bus routes.
 */
const DETAILED_ROUTES = 5;

/**
 * What a page of rows references, or null when it references nothing drawable.
 *
 * For a filter that names no id: `route_type = 0` in routes.txt selects the
 * light rail routes it leaves, and a filter on stops.txt selects those stops.
 * Read from the same columns as `selectionFromFilters`, whichever file the
 * rows are from.
 */
export function selectionFromRows(page: PageResponse): MapSelection | null {
  const picked: MapSelection = { routeIds: [], shapeIds: [], stopIds: [] };
  for (const [column, key] of Object.entries(DRAWN_COLUMNS)) {
    const index = page.columns.indexOf(column);
    if (index < 0) continue;
    for (const row of page.rows) if (row[index]) picked[key].push(row[index] as string);
  }
  const unique = {
    routeIds: [...new Set(picked.routeIds)],
    shapeIds: [...new Set(picked.shapeIds)],
    stopIds: [...new Set(picked.stopIds)],
  };
  return unique.routeIds.length || unique.shapeIds.length || unique.stopIds.length ? unique : null;
}

export class FilesMap {
  private selection: MapSelection | null = null;
  /** The selection's own geometry, kept so the network toggle redraws without refetching. */
  private extra: FeatureCollection | null = null;
  private stopIds: string[] = [];
  private showNetwork = false;
  /** Bumped on every change, so a slow fetch cannot draw over a newer selection. */
  private ticket = 0;

  constructor(
    private readonly map: MapHandle,
    private readonly source: ViewerSource,
    private readonly toggle: HTMLElement,
    input: HTMLInputElement,
  ) {
    input.addEventListener("change", () => {
      this.showNetwork = input.checked;
      void this.draw(false);
    });
  }

  /**
   * A Files view was opened: draw what it selects.
   *
   * A filter naming ids selects those ids. Any other filter selects what the
   * rows it leaves reference, when there are few enough to read; an
   * unfiltered file selects nothing, and the whole network is drawn.
   */
  follow(table: string, filters: Filter[]): void {
    const named = selectionFromFilters(filters);
    if (named || !filters.length) {
      void this.show(named);
      return;
    }
    const ticket = (this.ticket += 1);
    void this.source
      .query(table, filters, 1, ROW_LIMIT)
      .then((page) => (page.total <= ROW_LIMIT ? selectionFromRows(page) : null))
      .catch(() => null)
      .then((selection) => {
        if (ticket === this.ticket) void this.show(selection);
      });
  }

  /** A row's map button: draw that row's thing until the view changes. */
  pick(selection: MapSelection): void {
    void this.show(selection);
  }

  /** An Explore screen took the pane; it sets the map's focus itself. */
  leave(): void {
    this.ticket += 1;
    this.selection = null;
    this.toggle.hidden = true;
  }

  private async show(selection: MapSelection | null): Promise<void> {
    const ticket = (this.ticket += 1);
    this.selection = selection;
    this.toggle.hidden = !selection;
    if (!selection) {
      this.extra = null;
      this.stopIds = [];
      await this.map.focusRoutes(null);
      return;
    }

    const { extra, stopIds } = await this.geometry(selection);
    if (ticket !== this.ticket) return;
    this.extra = extra;
    this.stopIds = stopIds;
    await this.draw(true);
  }

  private async draw(frame: boolean): Promise<void> {
    const selection = this.selection;
    if (!selection) return;
    await this.map.focusRoutes(selection.routeIds, this.extra, !this.showNetwork, this.stopIds);
    if (frame) {
      // A stop or two is framed on the stops: framing a lone stop together
      // with nothing else would zoom to it, but a route's stops are framed
      // with its line so the whole route is in view.
      const stopsOnly = !selection.routeIds.length && !selection.shapeIds.length;
      await this.map.frameFocus(selection.routeIds, { stopsOnly });
    }
  }

  /**
   * The lines and stops a selection draws.
   *
   * A route is drawn from all of its shapes and stops, the way its card draws
   * it, when the source can describe the route; otherwise the `routes` layer's
   * one line for it stands in. Selected stops go into the highlight as well as
   * the stops filter, so a single stop is a marked point rather than one more
   * dot.
   */
  private async geometry(selection: MapSelection): Promise<{ extra: FeatureCollection | null; stopIds: string[] }> {
    const shapeIds = new Set(selection.shapeIds);
    const stopIds = new Set(selection.stopIds);

    const detailed = selection.routeIds.length <= DETAILED_ROUTES ? selection.routeIds : [];
    const details = await Promise.all(
      detailed.map((routeId) => this.source.route?.(routeId).catch(() => null) ?? Promise.resolve(null)),
    );
    // Each route's shapes in that route's colour: the light rail filter is
    // three lines, red, green and blue, and one highlight colour for all of
    // them made three lines read as one.
    const colors = new Map<string, string>();
    for (const detail of details) {
      if (!detail) continue;
      const color = routeLineColor(detail.route.route_color) ?? PALE_ROUTE_COLOR;
      for (const direction of detail.directions) {
        for (const id of direction.shape_ids) {
          shapeIds.add(id);
          colors.set(id, color);
        }
      }
      for (const pattern of detail.patterns) for (const stop of pattern.stops) stopIds.add(stop.stop_id);
    }

    const [shapes, stops] = await Promise.all([
      shapeIds.size ? this.source.geojson("shapes", [...shapeIds]).catch(() => null) : null,
      selection.stopIds.length ? this.source.geojson("stops", selection.stopIds).catch(() => null) : null,
    ]);
    const lines = (shapes?.features ?? []).map((feature) => {
      const color = colors.get(String((feature.properties as { shape_id?: string } | null)?.shape_id ?? ""));
      return color ? { ...feature, properties: { ...feature.properties, highlight_color: color } } : feature;
    });
    const features = [...lines, ...(stops?.features ?? [])];
    return {
      extra: features.length ? { type: "FeatureCollection", features } : null,
      stopIds: [...stopIds],
    };
  }
}
