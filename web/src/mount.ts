/**
 * Putting a viewer into a page.
 *
 * The standalone application and an embedded one differ only in what they pass
 * here: the application owns its page, so it takes the load dialog, the options
 * menu and the browser's own history; a host embedding the viewer takes none of
 * those and keeps its address bar to itself.
 */

import "./style.css";

import { createDom } from "./dom";
import { buildViewer, type ViewerParts } from "./markup";
import { RestSource } from "./sources/rest";
import type { Dom } from "./dom";
import type { FeatureCollection, TablesResponse, ViewerSource } from "./sources/types";
import { modeOf, type AppState, createState, type Mode, type View } from "./state";
import { FeedLoader } from "./ui/feed-loader";
import { OptionsMenu, showsWorkspace } from "./ui/options-menu";
import { FilterBar } from "./ui/filters";
import { type HistoryPort, memoryHistory } from "./ui/history";
import { initialView, Navigator } from "./ui/navigation";
import { describeDate, destinations, longDate, patternNames, stepDate } from "./ui/date-bar";
import { FilesMap, type MapSelection } from "./ui/files-map";
import { ScreenPane } from "./ui/screen-pane";
import { availableScreens, defaultScreens, type Screen } from "./ui/screens";
import { renderSidebar } from "./ui/sidebar";
import { TableView } from "./ui/table";

export type { ViewerParts } from "./markup";

/**
 * What a focus actually put on the map.
 *
 * Two numbers rather than one, because the difference is what a caller can
 * honestly say: a route with no shapes but with stops is not "nothing to
 * draw", and a single total could not tell the two apart.
 */
export interface FocusResult {
  lines: number;
  points: number;
}
export type { GtfsSource, ViewerSource } from "./sources/types";
/**
 * The payload types, re-exported so a host implementing `ViewerSource` can name
 * what its methods return. They are generated from `docs/GtfsGarageAPI.yaml`,
 * so an implementation written against them is checked against the contract at
 * compile time - which is the whole point of generating them, and is worth
 * nothing if they stop at the package boundary.
 */
export type {
  AppConfig,
  CalendarDay,
  CalendarSummary,
  ColumnInfo,
  ConditionOutcome,
  DatasetManifest,
  FeatureCollection,
  FileCondition,
  FileMetrics,
  Filter,
  FilterOperator,
  GeoFeature,
  GeoJsonKind,
  ImpliedValue,
  LoadMetrics,
  LoadProgress,
  MissingFile,
  Overview,
  PageResponse,
  RouteDetail,
  RouteSummary,
  ServicePattern,
  RelatedLink,
  Row,
  TableInfo,
  TablesResponse,
  WeekdayProfile,
  ValueCount,
} from "./sources/types";
/** `geojsonStream` hands these to its callback, so an implementer names them too. */
export type { NdjsonMessage } from "./sources/ndjson";
export { RestSource } from "./sources/rest";
export { browserHistory, memoryHistory, type HistoryPort } from "./ui/history";
/**
 * The screens, so a host can add one, replace one or drop them all. See
 * `ui/screens/index.ts` for what a screen is and how to write one.
 */
export {
  availableScreens,
  calendarScreen,
  defaultScreens,
  listedScreens,
  overviewScreen,
  renderCalendar,
  renderOverview,
  renderRoute,
  renderRouteList,
  routeListScreen,
  routeScreen,
  type Screen,
  type ScreenContext,
} from "./ui/screens";
/** The helpers a host's own screen can build on, rather than reimplement. */
export { action, append, node, section, stat } from "./ui/html";

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
   * The derived views, in sidebar order. Defaults to `defaultScreens`.
   *
   * A host can add its own, replace one of ours, reorder them, or pass `[]` for
   * the file browser alone. Each is narrowed per feed by its own `available`,
   * so a screen whose source cannot answer it never appears.
   */
  screens?: Screen[];
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
  /**
   * Draw only these routes, or null for the whole network.
   *
   * `extra` adds geometry of the caller's own - a single route's shapes, which
   * the layer only holds one of. `stopIds` narrows the stops layer to that
   * route's stops and emphasises them, rather than hiding every stop in the
   * feed. `isolate` false keeps the rest of the network drawn behind the focus;
   * the focus stays picked out either way.
   *
   * Returns what was actually drawn, lines and points separately, so a caller
   * can tell "no shapes but here are its stops" from "nothing to draw at all".
   */
  focusRoutes(
    routeIds: string[] | null,
    extra?: FeatureCollection | null,
    isolate?: boolean,
    stopIds?: string[],
  ): Promise<FocusResult>;
  /**
   * Frame the map on what the focus is showing. `stopsOnly` frames on the
   * focused stops rather than the route's line, for a focus that is part of a
   * route rather than all of it.
   */
  frameFocus(routeIds: string[], options?: { stopsOnly?: boolean }): Promise<void>;
  /** Centre on one stop and mark it. False when the feed gives it no position. */
  focusStop(stopId: string): Promise<boolean>;
  /**
   * Look at the pane again after its box changed.
   *
   * Nothing fires on a pure CSS reflow, so a map moved from beside a screen to
   * above one keeps the old canvas size until it is told.
   */
  resize(): void;
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

const EMBEDDED = { load: false, options: false } as const;

/**
 * Whether this source can build the geometry a map action needs.
 *
 * `geojson` is required by `GtfsSource`, so its presence proves nothing - a
 * source that cannot draw a map implements it by rejecting. The flag is on the
 * source itself, so such a source says so once rather than being discovered at
 * the first click.
 */
function canDrawShapes(source: ViewerSource): boolean {
  return source.drawsGeometry !== false;
}

export async function mount(root: Element, options: ViewerOptions = {}): Promise<Viewer> {
  const parts: ViewerParts = { ...EMBEDDED, ...options.parts, map: Boolean(options.map) };
  const source: ViewerSource = options.source ?? new RestSource(options.baseUrl);

  buildViewer(root, parts);
  const dom = createDom(root);
  const state = createState();

  // Read before anything is built: it carries both the basemap the map needs
  // and whether this server has a workdir for the options menu to show.
  const config = await source.config?.().catch(() => null);

  /**
   * The workdir part of the menu exists only where there is a workdir: a local
   * server has one; a host's own backend implementing the same endpoints, and a
   * browser reading Parquet, do not. The load report is shown either way, since
   * every source describes its own load.
   */
  const workspacePort = showsWorkspace(source, config) ? source : null;

  const optionsMenu = parts.options
    ? new OptionsMenu(dom, workspacePort, async () => {
        onFeedLoaded(await source.tables());
      })
    : undefined;

  // A vector style has to be fetched before the map is constructed, and which
  // one is a server setting unless the host names it.
  const basemap = options.basemap ?? config?.basemap;
  const map = await options.map?.create(dom, state, source, basemap);
  map?.restoreVisibility();

  // Files mode keeps the map on what the view selects; see FilesMap. Only
  // with a source that can build the geometry it draws.
  const filesMap =
    map && canDrawShapes(source)
      ? new FilesMap(map, source, dom.el("files-network"), dom.el<HTMLInputElement>("files-network-input"))
      : null;

  const loadPage = async (view: View): Promise<void> => {
    // A screen owns the pane while it is showing, so there is no page to fetch
    // and the file browser is left exactly as the reader left it.
    if (view.screen) {
      filesMap?.leave();
      return screenPane.show(view);
    }
    screenPane.hide();
    filesMap?.follow(view.table, view.filters);
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
    state.mode = modeOf(view);
    drawModes();
    drawDateChip();
    drawSidebar();
    filterBar?.render();
    void loadPage(view);
  });

  /** The Explore/Files switch: present only when there is something to switch to. */
  const drawModes = (): void => {
    const listed = state.screens.filter((screen) => screen.label).length;
    dom.el("mode-switch").hidden = listed === 0;
    dom.el("mode-explore").classList.toggle("active", state.mode === "explore");
    dom.el("mode-files").classList.toggle("active", state.mode === "files");
  };

  /**
   * The chosen day, and only when there is one.
   *
   * Nothing is filtered by date until someone asks for it, so an untouched
   * feed shows no control at all - and the route list shows every route the
   * feed has. The chip appears with the filter and leaves with it, which is
   * what makes the filtering visible rather than something to deduce.
   */
  const drawDateChip = (): void => {
    const chip = dom.el("date-chip");
    const date = state.view.date;
    chip.hidden = !date || state.mode !== "explore";
    dom.el("date-menu").hidden = true;
    if (chip.hidden || !date) return;

    const day = state.days.find((entry) => entry.service_date === date);
    dom.el("date-chip-day").textContent = longDate(date);
    dom.el("date-chip-note").textContent = describeDate(day, state.patterns.get(date));
  };

  /** Somewhere to go, each entry naming the date it lands on. */
  const drawJumpMenu = (): void => {
    const menu = dom.el("date-menu");
    menu.replaceChildren();

    const today = new Date().toISOString().slice(0, 10);
    for (const entry of destinations(state.days, state.jumpPatterns, today, state.view.date)) {
      const item = document.createElement("button");
      item.className = "date-menu-item";
      item.title = entry.note ? `${entry.date} — ${entry.note}` : entry.date;
      item.append(
        Object.assign(document.createElement("span"), { textContent: entry.label }),
        Object.assign(document.createElement("span"), {
          className: "date-menu-date",
          textContent: entry.date,
        }),
      );
      item.addEventListener("click", () => {
        menu.hidden = true;
        navigator.setDate(entry.date);
      });
      menu.append(item);
    }
    menu.hidden = menu.childElementCount === 0;
  };

  const drawSidebar = (): void =>
    renderSidebar(
      dom,
      state,
      (table) => navigator.selectTable(table),
      (screen) => navigator.showScreen(screen),
    );

  // Wired once, for every viewer: the chip itself stays hidden until a day is
  // chosen, and the mode switch until there is something to switch between.
  {
    dom.el("date-prev").addEventListener("click", () =>
      navigator.setDate(stepDate(state.days, state.view.date ?? "", -1)),
    );
    dom.el("date-next").addEventListener("click", () =>
      navigator.setDate(stepDate(state.days, state.view.date ?? "", 1)),
    );
    dom.el("date-clear").addEventListener("click", () => navigator.setDate(undefined));
    dom.el("date-jump").addEventListener("click", () => {
      const menu = dom.el("date-menu");
      if (menu.hidden) drawJumpMenu();
      else menu.hidden = true;
    });

    for (const [name, mode] of [
      ["mode-explore", "explore"],
      ["mode-files", "files"],
    ] as [string, Mode][]) {
      dom.el(name).addEventListener("click", () => navigator.switchMode(mode));
    }
  }

  filterBar = new FilterBar(dom, state, source, (filters) =>
    // Everything the view already was, with the new filters: built fresh, this
    // dropped the chosen day, so adding a filter in Files silently cleared the
    // date the Explore half was reading. Page 1, because row 240 of the old
    // result is not row 240 of the new one.
    navigator.go({ ...navigator.current(), filters, page: 1 }),
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
        // Picked out the way a filter would pick them, rather than laid over
        // the whole network: the row's thing alone, the rest one checkbox away.
        const pick = (selection: Partial<MapSelection>) =>
          filesMap?.pick({ routeIds: [], shapeIds: [], stopIds: [], ...selection });
        return {
          onHighlightStop: (stopId: string) =>
            filesMap ? pick({ stopIds: [stopId] }) : void show("stops", stopId, true),
          onHighlightShape: (shapeId: string) =>
            filesMap ? pick({ shapeIds: [shapeId] }) : void show("shapes", shapeId),
          onHighlightRoute: (routeId: string) => {
            if (filesMap) return pick({ routeIds: [routeId] });
            const shapeId = state.routeShapes.get(routeId);
            if (shapeId) void show("shapes", shapeId);
          },
          onHighlightLocation: (locationId: string) => void show("locations", locationId),
        };
      })()
    : {};

  const screenPane = new ScreenPane(
    dom,
    state,
    source,
    {
    openTable: (table, filters) => navigator.selectTable(table, filters ?? []),
    openScreen: (id, argument) => navigator.showScreen(id, argument),
    source,
    get date() {
      return state.view.date ?? null;
    },
    setDate: (date) => navigator.setDate(date),
    get params() {
      return state.view.params ?? {};
    },
    setParams: (params) => navigator.setParams(params),
    // Only when there is a map *and* a source that can build GeoJSON for it: a
    // screen must offer no map action rather than one that does nothing. A
    // browser source reading Parquet answers tables and not geometry.
    focusRoutes:
      map && canDrawShapes(source)
        ? async (routeIds, options) => {
            // The `routes` layer carries one representative shape per route,
            // which is right for a day's worth of them and wrong for a single
            // route - whose directions and variants are several shapes. A
            // caller that knows them passes them, and gets the whole route.
            let extra: FeatureCollection | null = null;
            if (routeIds?.length && options?.shapeIds?.length) {
              extra = await source.geojson("shapes", options.shapeIds).catch(() => null);
            }
            const drawn = await map.focusRoutes(
              routeIds,
              extra,
              options?.isolate ?? true,
              options?.stopIds ?? [],
            );
            if (routeIds?.length) {
              await map.frameFocus(routeIds, { stopsOnly: options?.frame === "stops" });
            }
            return drawn;
          }
        : undefined,
    focusStop:
      map && canDrawShapes(source) ? (stopId: string) => map.focusStop(stopId) : undefined,
    },
    // Nothing fires on a pure CSS reflow, so a map whose box just changed keeps
    // the old one until it is told to look again.
    () => map?.resize(),
  );

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
    if (data.metrics) optionsMenu?.showMetrics(data.metrics, clientMs);
    state.tables = data.tables;
    // Narrowed per feed rather than per mount: the source is what decides, and
    // a host can hand the viewer a different one when it reloads.
    state.screens = availableScreens(options.screens ?? defaultScreens, source);
    state.missing = data.missing ?? [];
    state.mapDataLoaded = false;
    state.routeShapes.clear();

    drawSidebar();
    void map?.refresh().catch((error) => console.error("Map layers failed to load:", error));

    const initial = initialView(
      data.tables,
      restoreFromUrl ? navigator.fromLocation() : null,
      state.screens,
    );
    if (initial) navigator.reset(initial, data.source);

    // The calendar, once per feed: it is what the date control steps along and
    // what names the kind of day. A feed without one simply has no control.
    // Read for the chip's wording and the jump list - **not** to choose a day.
    // A page that arrives already filtered by something nobody picked is the
    // confusion this whole control was rearranged to remove.
    void source
      .calendar?.()
      .then((calendar) => {
        state.days = calendar.days;
        state.patterns = patternNames(calendar.days, calendar.patterns);
        state.jumpPatterns = calendar.patterns;
        drawDateChip();
      })
      .catch(() => {
        // No calendar is not an error - plenty of feeds have none, and there
        // is then no day to offer.
        state.days = [];
        drawDateChip();
      });
  };

  const feedLoader = parts.load
    ? new FeedLoader(
        dom,
        source as RestSource,
        (data, clientMs) => onFeedLoaded(data, clientMs),
        () => state.tables.length > 0,
        workspacePort,
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
