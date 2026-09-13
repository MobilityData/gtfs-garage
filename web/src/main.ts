/** Wires the pieces together: source -> navigation -> table/filters/map. */

import "./style.css";

import { el } from "./dom";
import { MapController } from "./map/map";
import { RestSource } from "./sources/rest";
import type { TablesResponse } from "./sources/types";
import { createState, type View } from "./state";
import { FeedLoader } from "./ui/feed-loader";
import { initMetricsPanel, renderMetrics } from "./ui/feed-metrics";
import { FilterBar } from "./ui/filters";
import { initialView, Navigator } from "./ui/navigation";
import { renderSidebar } from "./ui/sidebar";
import { TableView } from "./ui/table";

async function start(): Promise<void> {
  const state = createState();
  const source = new RestSource();
  initMetricsPanel();

  // The basemap is a server setting, and a vector style has to be fetched
  // before the map can be constructed.
  const config = await source.config().catch(() => null);
  const map = await MapController.create(state, source, config?.basemap);
  map.restoreVisibility();

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

  const navigator = new Navigator(state, (view) => {
    renderSidebar(state, (table) => navigator.selectTable(table));
    filterBar?.render();
    void loadPage(view);
  });

  filterBar = new FilterBar(state, source, (filters) =>
    navigator.go({ table: state.view.table, filters, page: 1 }),
  );

  const tableView = new TableView(state, {
    onNavigate: (table, filters) => navigator.selectTable(table, filters),
    onPage: (page) => navigator.go({ ...navigator.current(), page }),
    onHighlightStop: async (stopId) => {
      await map.highlight(await source.geojson("stops", [stopId]), { point: true });
    },
    onHighlightShape: async (shapeId) => {
      await map.highlight(await source.geojson("shapes", [shapeId]));
    },
    onHighlightRoute: async (routeId) => {
      const shapeId = state.routeShapes.get(routeId);
      if (shapeId) await map.highlight(await source.geojson("shapes", [shapeId]));
    },
  });

  /**
   * `restoreFromUrl` is only true on page load, so a reloaded or shared link
   * returns to its view. Opening a different feed starts clean: the previous
   * feed's filters do not describe this one's data.
   */
  const onFeedLoaded = (data: TablesResponse, clientMs?: number, restoreFromUrl = false): void => {
    feedLoader.close();
    el("source-label").textContent = data.source;
    renderMetrics(data.metrics, clientMs);
    state.tables = data.tables;
    state.mapDataLoaded = false;
    state.routeShapes.clear();

    renderSidebar(state, (table) => navigator.selectTable(table));
    void map.refresh().catch((error) => console.error("Map layers failed to load:", error));

    const initial = initialView(data.tables, restoreFromUrl ? Navigator.fromUrl() : null);
    if (initial) navigator.reset(initial, data.source);
  };

  const feedLoader = new FeedLoader(
    source,
    (data, clientMs) => onFeedLoaded(data, clientMs),
    () => state.tables.length > 0,
  );

  try {
    // No client timing on this path: a feed named on the command line was
    // opened before the page existed, so there is no round trip to report.
    onFeedLoaded(await source.tables(), undefined, true);
  } catch {
    // Nothing loaded yet (409) or the server is unreachable - let the user pick.
    feedLoader.open();
  }
}

void start();
