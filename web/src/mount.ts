/**
 * Putting a viewer into a page.
 *
 * The standalone application and an embedded one differ only in what they pass
 * here: the application owns its page, so it takes the load dialog, the load
 * report and the browser's own history; a host embedding the viewer takes none
 * of those and keeps its address bar to itself.
 */

import "./style.css";

import { createDom } from "./dom";
import { buildViewer, type ViewerParts } from "./markup";
import { RestSource } from "./sources/rest";
import type { Dom } from "./dom";
import type { FeatureCollection, TablesResponse, ViewerSource } from "./sources/types";
import { type AppState, createState, type View } from "./state";
import { FeedLoader } from "./ui/feed-loader";
import { initMetricsPanel, renderMetrics } from "./ui/feed-metrics";
import { FilterBar } from "./ui/filters";
import { type HistoryPort, memoryHistory } from "./ui/history";
import { initialView, Navigator } from "./ui/navigation";
import { renderSidebar } from "./ui/sidebar";
import { TableView } from "./ui/table";

export type { ViewerParts } from "./markup";
export type { GtfsSource, ViewerSource } from "./sources/types";
export { RestSource } from "./sources/rest";
export { browserHistory, memoryHistory, type HistoryPort } from "./ui/history";

export interface ViewerOptions {
  /** Where feed data comes from. Defaults to a REST source against `baseUrl`. */
  source?: ViewerSource;
  /** Base URL for the default REST source. Defaults to the current origin. */
  baseUrl?: string;
  /**
   * Preset name, raster tile template or vector style URL. Falls back to the
   * server's own setting when the source can report one.
   */
  basemap?: string;
  /**
   * The map implementation, from this package's `./map` entry. Omitted means no
   * map pane: there is nothing to draw one with.
   */
  map?: MapPart;
  /** Which of the remaining pieces to build - see `ViewerParts`. */
  parts?: Omit<ViewerParts, "map">;
  /**
   * Defaults to a back stack the viewer keeps to itself. The application passes
   * `browserHistory()` so that a view is a shareable link; an embedded viewer
   * leaves its host's address bar alone.
   */
  history?: HistoryPort;
}

/**
 * The map, supplied by whoever wants one.
 *
 * MapLibre is a megabyte, and a host that does not show a map should not carry
 * it or even have to install it. A lazy `import()` is not enough - bundlers
 * resolve the specifier at build time regardless of whether the branch runs,
 * so esbuild fails outright on a consumer that has no MapLibre. Keeping the
 * map behind its own entry point means it is absent from the module graph
 * rather than merely unreached:
 *
 *     import { mount } from "gtfs-garage-web";
 *     import { mapPart } from "gtfs-garage-web/map";
 *
 *     mount(root, { map: mapPart });   // omit it and there is no map pane
 */
export interface MapPart {
  create(
    dom: Dom,
    state: AppState,
    source: ViewerSource,
    basemap?: string | null,
  ): Promise<MapHandle>;
}

export interface MapHandle {
  restoreVisibility(): void;
  refresh(): Promise<void>;
  highlight(collection: FeatureCollection, options?: { point?: boolean }): Promise<void>;
  destroy(): void;
}

export interface Viewer {
  /**
   * Give up the map, the history subscription and the markup.
   *
   * Not optional for a host: React remounts every effect in development, so a
   * viewer that cannot be taken down appears twice and holds two WebGL
   * contexts, of which a browser allows only a handful.
   */
  destroy(): void;
}

const EMBEDDED = { load: false, report: false } as const;

export async function mount(root: Element, options: ViewerOptions = {}): Promise<Viewer> {
  const parts: ViewerParts = { ...EMBEDDED, ...options.parts, map: Boolean(options.map) };
  const source: ViewerSource = options.source ?? new RestSource(options.baseUrl);

  buildViewer(root, parts);
  const dom = createDom(root);
  const state = createState();
  if (parts.report) initMetricsPanel(dom);

  // A vector style has to be fetched before the map is constructed, and which
  // one is a server setting unless the host names it.
  const basemap = options.basemap ?? (await source.config?.().catch(() => null))?.basemap;
  const map = await options.map?.create(dom, state, source, basemap);
  map?.restoreVisibility();

  const loadPage = async (view: View): Promise<void> => {
    try {
      tableView.render(await source.query(view.table, view.filters, view.page, state.pageSize));
    } catch (error) {
      tableView.showMessage(`Could not load ${view.table}: ${(error as Error).message}`);
    }
  };

  // The navigator drives redraws and the filter bar drives the navigator, so one
  // of the two is referenced before it is built. The callback only runs once a
  // view is applied, by which point both exist.
  let filterBar: FilterBar | undefined;

  const navigator = new Navigator(dom, options.history ?? memoryHistory(), state, (view) => {
    renderSidebar(dom, state, (table) => navigator.selectTable(table));
    filterBar?.render();
    void loadPage(view);
  });

  filterBar = new FilterBar(dom, state, source, (filters) =>
    navigator.go({ table: state.view.table, filters, page: 1 }),
  );

  /**
   * Supplied only when there is a map.
   *
   * Their absence removes the row buttons and the column that holds them; see
   * `rowActions`.
   */
  const highlights = map
    ? (() => {
        const show = async (kind: "stops" | "shapes" | "locations", id: string, point = false) => {
          await map.highlight(await source.geojson(kind, [id]), { point });
        };
        return {
          onHighlightStop: (stopId: string) => void show("stops", stopId, true),
          onHighlightShape: (shapeId: string) => void show("shapes", shapeId),
          onHighlightRoute: (routeId: string) => {
            const shapeId = state.routeShapes.get(routeId);
            if (shapeId) void show("shapes", shapeId);
          },
          onHighlightLocation: (locationId: string) => void show("locations", locationId),
        };
      })()
    : {};

  const tableView = new TableView(dom, state, {
    onNavigate: (table, filters) => navigator.selectTable(table, filters),
    onPage: (page) => navigator.go({ ...navigator.current(), page }),
    ...highlights,
  });

  // A display preference, so it redraws the page in place rather than going
  // through the navigator: toggling it is not a new view to go Back from.
  const rawValues = dom.el<HTMLInputElement>("raw-values-input");
  rawValues.addEventListener("change", () => {
    state.rawValues = rawValues.checked;
    tableView.redraw();
  });

  /**
   * `restoreFromUrl` is only true on page load, so a reloaded or shared link
   * returns to its view. Opening a different feed starts clean: the previous
   * feed's filters do not describe this one's data.
   */
  const onFeedLoaded = (data: TablesResponse, clientMs?: number, restoreFromUrl = false): void => {
    feedLoader?.close();
    dom.el("source-label").textContent = data.source;
    if (parts.report && data.metrics) renderMetrics(dom, data.metrics, clientMs);
    state.tables = data.tables;
    state.missing = data.missing ?? [];
    state.mapDataLoaded = false;
    state.routeShapes.clear();

    renderSidebar(dom, state, (table) => navigator.selectTable(table));
    void map?.refresh().catch((error) => console.error("Map layers failed to load:", error));

    const initial = initialView(data.tables, restoreFromUrl ? navigator.fromLocation() : null);
    if (initial) navigator.reset(initial, data.source);
  };

  const feedLoader = parts.load
    ? new FeedLoader(
        dom,
        source as RestSource,
        (data, clientMs) => onFeedLoaded(data, clientMs),
        () => state.tables.length > 0,
      )
    : undefined;

  try {
    // No client timing on this path: a feed named on the command line was
    // opened before the page existed, so there is no round trip to report.
    onFeedLoaded(await source.tables(), undefined, parts.load);
  } catch (error) {
    // Nothing loaded yet (409) or the server is unreachable. The application
    // lets the user pick a feed; an embedded viewer has no such dialog, so it
    // says what happened instead of sitting blank.
    if (feedLoader) feedLoader.open();
    else tableView.showMessage(`Could not load the feed: ${(error as Error).message}`);
  }

  return {
    destroy() {
      navigator.destroy();
      map?.destroy();
      root.replaceChildren();
      root.classList.remove("gtfs-viewer");
    },
  };
}
