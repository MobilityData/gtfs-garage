import type MapLibre from "maplibre-gl";

import type { Dom } from "../dom";
import type { FocusResult } from "../mount";
import type { FeatureCollection, GeoJsonKind, ViewerSource } from "../sources/types";
import type { AppState } from "../state";
import { resolveBasemap } from "./basemap";
import { bboxOf } from "./geo";
import {
  buildStyle,
  EMPTY_FEATURE_COLLECTION,
  PALE_ROUTE_COLOR,
  ROUTE_CASING_WIDTH,
  ROUTE_CASING_WIDTH_FOCUSED,
  ROUTE_OPACITY,
  ROUTE_OPACITY_FOCUSED,
  ROUTE_WIDTH,
  ROUTE_WIDTH_FOCUSED,
  routeLineColor,
  SOURCE_IDS,
  STOP_OPACITY,
  STOP_OPACITY_FOCUSED,
  STOP_RADIUS,
  STOP_RADIUS_FOCUSED,
  type SourceId,
} from "./layers";
import { createRedrawSchedule } from "./redraw";

const MAP_VISIBLE_KEY = "gtfs-garage.map-visible";



/** Drawn in this order: the coloured routes first, so something useful appears
 * within a second even on a feed whose shapes take half a minute. */
const LAYER_ORDER: GeoJsonKind[] = ["routes", "locations", "stops", "shapes"];

const LAYER_NOUNS: Record<GeoJsonKind, string> = {
  routes: "routes",
  stops: "stops",
  shapes: "shapes",
  locations: "zones",
};


export class MapController {
  private readonly map: any;
  private readonly ready: Promise<void>;

  /**
   * A vector basemap has to be fetched before the map is constructed, and
   * MapLibre itself is fetched here rather than imported at the top of the
   * file.
   *
   * That is what keeps it optional. A host that mounts the viewer without the
   * map part never reaches this method, so its bundler never follows the
   * import and none of MapLibre's ~1 MB is downloaded. A static import would
   * make it a cost every consumer pays whether or not they show a map.
   */
  static async create(
    dom: Dom,
    state: AppState,
    source: ViewerSource,
    basemap?: string | null,
  ): Promise<MapController> {
    const [maplibregl, style] = await Promise.all([
      import("maplibre-gl").then((module) => module.default),
      buildStyle(resolveBasemap(basemap)),
    ]);
    return new MapController(maplibregl, dom, state, source, style);
  }

  /** Cancels an in-flight refresh when a new feed arrives mid-draw. */
  private drawing: AbortController | null = null;
  /** The first full draw, while it is still running. See `highlight`. */
  private pendingRefresh: Promise<void> | null = null;

  /** Layers the server thinned to fit, and by how much. */
  private readonly simplifiedLayers = new Map<GeoJsonKind, number>();

  /**
   * The route features as drawn, kept for framing a focus.
   *
   * `querySourceFeatures` only returns what is currently in view, so framing
   * on it cannot move the map to a route that is off screen - which is every
   * route, the moment a feed covers more than one city. This is the same
   * object MapLibre already holds, so keeping it costs nothing.
   */
  private routeFeatures: FeatureCollection = { type: "FeatureCollection", features: [] };
  /** The stops as drawn, for framing a focus that has no lines to frame on. */
  private stopFeatures: FeatureCollection = { type: "FeatureCollection", features: [] };

  /** The mark left by `focusStop`, so the next call can move it. */
  private stopMark: MapLibre.Marker | null = null;

  /**
   * What is currently in focus, so a redraw can put it back.
   *
   * `isolate` is the difference between "this route and nothing else" and
   * "this route, picked out against the rest of the network". Both keep the
   * route emphasised; only the first hides everything around it.
   */
  private focus: {
    routeIds: string[];
    stopIds: string[];
    extra: FeatureCollection | null;
    isolate: boolean;
  } | null = null;

  private constructor(
    private readonly maplibregl: typeof MapLibre,
    private readonly dom: Dom,
    private readonly state: AppState,
    private readonly source: ViewerSource,
    style: Record<string, unknown>,
  ) {
    this.map = new maplibregl.Map({
      // The element itself, not an id: the viewer builds its own markup and
      // tags elements with data-el, so there is no id for MapLibre to find.
      container: dom.el("map"),
      center: [0, 20],
      zoom: 1,
      attributionControl: { compact: true },
      // `buildStyle` composes the basemap with this viewer's own layers and is
      // covered by layers.test.ts; it is typed as a plain record, not against
      // MapLibre.
      style: style as MapLibre.StyleSpecification,
    });
    this.map.addControl(new this.maplibregl.NavigationControl(), "top-right");
    this.map.addControl(new this.maplibregl.ScaleControl());

    this.map.on("click", "stops", (event: any) => {
      const properties = event.features[0].properties;
      new this.maplibregl.Popup()
        .setLngLat(event.lngLat)
        .setHTML(`<strong>${properties.stop_name ?? ""}</strong><br>${properties.stop_id}`)
        .addTo(this.map);
    });
    for (const layer of ["stops", "routes"]) {
      this.map.on("mouseenter", layer, () => (this.map.getCanvas().style.cursor = "pointer"));
      this.map.on("mouseleave", layer, () => (this.map.getCanvas().style.cursor = ""));
    }

    // Resolves once the style object exists, which does not require a paint.
    this.ready = new Promise((resolve) => {
      const poll = () => {
        if (this.map.getSource("stops")) resolve();
        else window.setTimeout(poll, 50);
      };
      poll();
    });

    this.dom.el("toggle-map-btn").addEventListener("click", () => this.setVisible(!this.isVisible()));
  }

  /** See `MapHandle.resize`. */
  resize(): void {
    this.map.resize();
  }

  isVisible(): boolean {
    return !this.dom.el("map-pane").hidden;
  }

  /** Restore the saved preference; defaults to shown. */
  restoreVisibility(): void {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(MAP_VISIBLE_KEY);
    } catch {
      /* private browsing - fall through to the default */
    }
    this.setVisible(saved !== "0");
  }

  setVisible(visible: boolean): void {
    this.dom.el("map-pane").hidden = !visible;
    this.dom.el("toggle-map-btn").textContent = visible ? "Hide map" : "Show map";
    try {
      localStorage.setItem(MAP_VISIBLE_KEY, visible ? "1" : "0");
    } catch {
      /* preference simply will not persist */
    }
    if (!visible) return;

    this.map.resize();
    // `refresh` publishes itself as `pendingRefresh`, so anything drawn while
    // it runs waits for it rather than being wiped by it.
    if (!this.state.mapDataLoaded) {
      void this.refresh().catch((error) => console.error("Map layers failed to load:", error));
    }
  }

  private async setSourceData(id: SourceId, data: unknown): Promise<void> {
    await this.ready;
    this.map.getSource(id).setData(data);
  }

  private fitTo(collection: FeatureCollection, maxZoom: number): void {
    const bbox = bboxOf(collection);
    if (bbox) this.map.fitBounds(bbox, { padding: 40, maxZoom, duration: 600 });
  }

  /**
   * Show these routes and nothing else, or go back to the whole network.
   *
   * The cheap half is a filter on the layer the feed is already drawn into:
   * the `routes` source carries `route_id` on every feature, so narrowing to
   * one costs a style update and no request, which is what makes it usable on
   * a feed whose shapes took half a minute to arrive.
   *
   * That layer holds **one representative shape per route**, though, so for a
   * single route the caller can pass the route's own shapes in `extra` and get
   * all of its variants rather than one of them. A route whose trips name no
   * shape at all has neither, which is why this reports how much it drew: an
   * empty map with a panel claiming to show a route is worse than saying there
   * is nothing to show.
   *
   * `shapes` holds the lines no route claims, and `stops` every stop in the
   * feed. Neither can be filtered to a route - their features carry no
   * route_id - so both are hidden while a focus is on, but only when the focus
   * has something of its own to put there.
   */
  async focusRoutes(
    routeIds: string[] | null,
    extra?: FeatureCollection | null,
    isolate = true,
    stopIds: string[] = [],
  ): Promise<FocusResult> {
    await this.ready;
    // Asked to show something, so show the map - and wait for the first draw if
    // it is still running, since a filter set before the layer exists applies
    // to nothing.
    if (routeIds && !this.isVisible()) this.setVisible(true);
    if (this.pendingRefresh) await this.pendingRefresh;

    this.focus = routeIds === null ? null : { routeIds, stopIds, extra: extra ?? null, isolate };
    // The mark belongs to whatever was in focus when it was left. A screen
    // showing something else should not inherit a pin on someone's stop.
    if (routeIds === null) {
      this.stopMark?.remove();
      this.stopMark = null;
    }
    return this.applyFocus();
  }

  /**
   * Put the current focus on the map, and say how many features it drew.
   *
   * Separate from `focusRoutes` because a redraw has to reapply it: `refresh`
   * clears every source, and a focus set while the feed was still streaming
   * would otherwise be wiped by the draw it was waiting for.
   */
  private async applyFocus(): Promise<FocusResult> {
    const focus = this.focus;

    const wantedRoutes = new Set(focus?.routeIds ?? []);
    const focusedRoutes = focus
      ? this.routeFeatures.features.filter((feature) =>
          wantedRoutes.has((feature.properties as { route_id?: string }).route_id ?? ""),
        )
      : [];
    const ownLines = focus?.extra?.features.length ?? 0;
    const lines = ownLines + focusedRoutes.length;

    // The highlight carries the focused route's own geometry and is set
    // whether or not the rest is hidden - that is what keeps the route picked
    // out when someone asks to see it in context rather than alone. Drawn in
    // the route's colour when there is one route to take it from.
    // A route too pale to see is drawn grey, as the routes layer draws it, so
    // it looks the same picked out as it does in the network.
    const color =
      focusedRoutes.length === 1
        ? (routeLineColor((focusedRoutes[0].properties as { route_color?: string }).route_color) ??
          PALE_ROUTE_COLOR)
        : null;
    const extra = focus?.extra ?? EMPTY_FEATURE_COLLECTION;
    await this.setSourceData(
      "highlight",
      color
        ? {
            ...extra,
            features: extra.features.map((feature) => ({
              ...feature,
              // A colour the caller already gave a feature wins: it knows
              // which route each shape belongs to, and this only knows one.
              properties: { highlight_color: color, ...feature.properties },
            })),
          }
        : extra,
    );

    // Stops are filtered the way routes are, by an id the features already
    // carry - no fetch, and no limit on how many a route may have.
    const wantedStops = new Set(focus?.stopIds ?? []);
    const points = wantedStops.size
      ? this.stopFeatures.features.filter((feature) =>
          wantedStops.has((feature.properties as { stop_id?: string }).stop_id ?? ""),
        ).length
      : 0;

    // Isolating means hiding everything else - but only when the focus has
    // something of its own to put there. A route whose trips name no shape and
    // whose stops are unplaceable has nothing to draw, and an empty map tells a
    // reader less than the network they can at least orient by.
    const isolating = Boolean(focus?.isolate) && lines + points > 0;

    // When the focus brings the route's own shapes, its one representative line
    // in the `routes` layer is hidden: that line may be a short working or one
    // branch, and drawn alongside a trip it shows a stretch the trip never runs.
    const focused = ["in", ["get", "route_id"], ["literal", focus?.routeIds ?? []]];
    const routeFilter = isolating
      ? ownLines
        ? null
        : focused
      : ownLines
        ? ["!", focused]
        : null;
    const routesVisible = !(isolating && ownLines);
    for (const layer of ["routes", "routes-white"]) {
      this.map.setFilter(layer, routeFilter);
      this.map.setLayoutProperty(layer, "visibility", routesVisible ? "visible" : "none");
    }
    // Routes drawn as the subject are drawn to be seen; see ROUTE_WIDTH. Only
    // while isolating: picked out against the network, the network's own
    // widths are what keep the rest of it readable around them.
    const emphasised = isolating && !ownLines && (focus?.routeIds.length ?? 0) > 0;
    this.map.setPaintProperty("routes", "line-width", emphasised ? ROUTE_WIDTH_FOCUSED : ROUTE_WIDTH);
    this.map.setPaintProperty("routes", "line-opacity", emphasised ? ROUTE_OPACITY_FOCUSED : ROUTE_OPACITY);
    this.map.setPaintProperty(
      "routes-white",
      "line-width",
      emphasised ? ROUTE_CASING_WIDTH_FOCUSED : ROUTE_CASING_WIDTH,
    );
    this.map.setLayoutProperty("shapes", "visibility", isolating ? "none" : "visible");

    // The stops of the thing in focus are the point of looking at it. Hidden
    // only when isolating with no stops named - a day's worth of routes, where
    // every stop in the city would be noise rather than an answer.
    const showingStops = isolating && points > 0;
    this.map.setFilter(
      "stops",
      showingStops ? ["in", ["get", "stop_id"], ["literal", focus!.stopIds]] : null,
    );
    this.map.setLayoutProperty("stops", "visibility", isolating && !showingStops ? "none" : "visible");
    this.map.setPaintProperty("stops", "circle-radius", showingStops ? STOP_RADIUS_FOCUSED : STOP_RADIUS);
    this.map.setPaintProperty("stops", "circle-opacity", showingStops ? STOP_OPACITY_FOCUSED : STOP_OPACITY);

    return { lines, points };
  }

  /**
   * Frame the map on what the focus is showing.
   *
   * `stopsOnly` frames on the focused stops instead of the route's line, for a
   * caller that has narrowed to part of a route - one trip of it, say. The
   * line is still drawn, but framing on it would hold the viewport over the
   * whole route and a short working would move the map not at all, which reads
   * as a click that did nothing.
   */
  async frameFocus(routeIds: string[], options: { stopsOnly?: boolean } = {}): Promise<void> {
    await this.ready;
    // A deep link opens a route while the feed's geometry is still streaming;
    // framing before it lands would frame nothing.
    if (this.pendingRefresh) await this.pendingRefresh;

    const wanted = new Set(routeIds);
    const wantedStops = new Set(this.focus?.stopIds ?? []);
    // A route with no shapes still has stops, and framing on them is the
    // difference between showing it and showing the whole world.
    const stops = this.stopFeatures.features.filter((feature) =>
      wantedStops.has((feature.properties as { stop_id?: string }).stop_id ?? ""),
    );
    const lines = [
      ...(this.focus?.extra?.features ?? []),
      ...this.routeFeatures.features.filter((feature) =>
        wanted.has((feature.properties as { route_id?: string }).route_id ?? ""),
      ),
    ];

    // Only when there is something to frame on: a stop with no position in the
    // feed must leave the viewport alone rather than fly to nowhere.
    const features = options.stopsOnly && stops.length ? stops : [...lines, ...stops];
    if (features.length) this.fitTo({ type: "FeatureCollection", features }, 14);
  }

  /**
   * Centre on one stop and mark it, so a row in a table has a place on the map.
   *
   * The mark is a DOM marker rather than a layer: the `highlight` source is
   * already carrying the focused route's own geometry, and borrowing it here
   * would erase the route to show one of its stops. Returns whether the stop
   * has a position at all - plenty of feeds have stops with no coordinates,
   * and a reader deserves to be told rather than watch nothing happen.
   */
  async focusStop(stopId: string): Promise<boolean> {
    await this.ready;
    if (!this.isVisible()) this.setVisible(true);
    if (this.pendingRefresh) await this.pendingRefresh;

    const feature = this.stopFeatures.features.find(
      (entry) => ((entry.properties as { stop_id?: string }).stop_id ?? "") === stopId,
    );
    const centre = (feature?.geometry as { coordinates?: [number, number] } | undefined)?.coordinates;
    if (!centre) return false;

    this.map.easeTo({ center: centre, zoom: Math.max(this.map.getZoom(), 14), duration: 600 });

    // One mark at a time: clicking down a list of stops should move the mark,
    // not leave a trail of them.
    this.stopMark?.remove();
    const element = document.createElement("div");
    element.className = "stop-mark";
    this.stopMark = new this.maplibregl.Marker({ element }).setLngLat(centre).addTo(this.map);
    return true;
  }

  async highlight(collection: FeatureCollection, options: { point?: boolean } = {}): Promise<void> {
    // Asked to see something on the map, so show the map.
    if (!this.isVisible()) this.setVisible(true);
    // Revealing the map may have started the first full draw, which wipes every
    // source. Without waiting, clicking a row before the map has ever loaded
    // revealed it with nothing selected.
    if (this.pendingRefresh) await this.pendingRefresh;
    await this.setSourceData("highlight", collection);
    if (collection.features.length) this.fitTo(collection, options.point ? 16 : 14);
  }

  private showProgress(text: string): void {
    const element = this.dom.el("map-progress");
    element.textContent = text;
    element.hidden = text === "";
  }

  /**
   * Draw one layer as it arrives.
   *
   * The features are handed over repeatedly rather than once at the end, so a
   * large feed paints steadily instead of freezing the tab and then jumping.
   * Returns what was collected, for the caller to frame the view with.
   */
  private async drawLayer(kind: GeoJsonKind, signal: AbortSignal): Promise<void> {
    const collection: FeatureCollection = { type: "FeatureCollection", features: [] };
    let total = 0;
    let framed = false;
    // Growth-based, not per batch: see redraw.ts for why that matters.
    const redrawDue = createRedrawSchedule();
    let simplified = 0;
    // Redraws are chained rather than fired in parallel: each hands MapLibre
    // the whole collection, and overlapping them would only duplicate that.
    let redrawing: Promise<void> = Promise.resolve();

    await this.source.geojsonStream(
      kind,
      (message) => {
        if (message.type === "header") {
          total = message.total;
          // Above a vertex budget the server sends every nth point of each
          // line. No shape is dropped, but the detail is reduced, and quietly
          // showing a coarser map than the feed contains would be misleading.
          if (message.step > 1) simplified = message.step;
          this.showProgress(`Drawing 0 of ${total.toLocaleString()} ${LAYER_NOUNS[kind]}…`);
          return;
        }
        const features = message.features as FeatureCollection["features"];
        collection.features.push(...features);

        // The total is what the server expects to emit; clamp so a feed with
        // an unmappable row never reads as "236,173 of 236,172".
        const drawn = Math.min(collection.features.length, total);
        this.showProgress(
          `Drawing ${drawn.toLocaleString()} of ${total.toLocaleString()} ${LAYER_NOUNS[kind]}…`,
        );
        if (kind === "routes") {
          // Two ids per route is all the highlight needs; see AppState.
          for (const feature of features) {
            this.state.routeShapes.set(feature.properties.route_id, feature.properties.shape_id);
          }
        }
        if (!framed) {
          // Frame on the first batch alone. bboxOf visits every coordinate,
          // and over ten million of them that cannot be repeated per redraw.
          framed = true;
          this.fitTo({ type: "FeatureCollection", features }, 13);
        }
        if (redrawDue(collection.features.length)) {
          redrawing = redrawing.then(() => this.setSourceData(kind, collection));
        }
      },
      signal,
    );

    await redrawing;
    await this.setSourceData(kind, collection);
    if (kind === "routes") this.routeFeatures = collection;
    if (kind === "stops") this.stopFeatures = collection;
    if (simplified) this.simplifiedLayers.set(kind, simplified);
  }

  /** Names the layers the server had to reduce, once everything is drawn. */
  private simplificationNote(): string {
    const reduced = [...this.simplifiedLayers.keys()].map((kind) => LAYER_NOUNS[kind]);
    if (!reduced.length) return "";
    return `Showing every point of ${reduced.join(" and ")} would not fit in a browser, so their lines are simplified. No shape is missing.`;
  }

  /**
   * Fetch and draw the whole feed. Skipped entirely while the map is hidden.
   *
   * Publishes itself as `pendingRefresh` for the whole of its run, so anything
   * that draws - a highlight, a screen's focus - waits for it instead of being
   * cleared by the pass it was racing. That the *application's* first draw was
   * not published this way is what made a deep-linked route report "nothing to
   * draw": it asked an empty layer and believed the answer.
   */
  async refresh(): Promise<void> {
    if (!this.isVisible()) return;
    const running = this.draw();
    this.pendingRefresh = running.finally(() => {
      if (this.pendingRefresh === running) this.pendingRefresh = null;
    });
    return running;
  }

  private async draw(): Promise<void> {
    // A load arriving mid-draw abandons the previous feed's layers rather than
    // racing them onto the map after the new feed has already been drawn.
    this.drawing?.abort();
    const controller = new AbortController();
    this.drawing = controller;
    this.simplifiedLayers.clear();
    this.state.routeShapes.clear();
    this.routeFeatures = { type: "FeatureCollection", features: [] };
    this.stopFeatures = { type: "FeatureCollection", features: [] };

    for (const id of SOURCE_IDS) await this.setSourceData(id, EMPTY_FEATURE_COLLECTION);

    try {
      for (const kind of LAYER_ORDER) await this.drawLayer(kind, controller.signal);
      this.state.mapDataLoaded = true;
      // A screen opened by a deep link sets its focus while this is still
      // streaming; drawing clears every source, so the focus is put back
      // rather than silently lost to the draw it was waiting for.
      await this.applyFocus();
    } catch (error) {
      if ((error as Error).name !== "AbortError") throw error;
    } finally {
      if (this.drawing === controller) {
        this.drawing = null;
        this.showProgress(this.simplificationNote());
      }
    }
  }

  async clear(): Promise<void> {
    for (const id of SOURCE_IDS) await this.setSourceData(id, EMPTY_FEATURE_COLLECTION);
  }

  /**
   * Give up the map and everything holding it.
   *
   * An embedded viewer is unmounted and remounted by its host - React does it
   * twice on every mount in development - and a MapLibre instance left behind
   * keeps a WebGL context, which browsers allow only a handful of.
   */
  destroy(): void {
    this.drawing?.abort();
    this.stopMark?.remove();
    this.map.remove();
  }
}
