import type MapLibre from "maplibre-gl";

import type { Dom } from "../dom";
import type { FeatureCollection, GeoJsonKind, ViewerSource } from "../sources/types";
import type { AppState } from "../state";
import { resolveBasemap } from "./basemap";
import { bboxOf } from "./geo";
import { buildStyle, EMPTY_FEATURE_COLLECTION, SOURCE_IDS, type SourceId } from "./layers";
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
    if (!this.state.mapDataLoaded) {
      // Kept rather than fired and forgotten, because `refresh` clears every
      // source on its way in - `highlight` included - so anything drawn while
      // it runs has to wait for it.
      this.pendingRefresh = this.refresh()
        .catch((error) => console.error("Map layers failed to load:", error))
        .finally(() => {
          this.pendingRefresh = null;
        });
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
    if (simplified) this.simplifiedLayers.set(kind, simplified);
  }

  /** Names the layers the server had to reduce, once everything is drawn. */
  private simplificationNote(): string {
    const reduced = [...this.simplifiedLayers.keys()].map((kind) => LAYER_NOUNS[kind]);
    if (!reduced.length) return "";
    return `Showing every point of ${reduced.join(" and ")} would not fit in a browser, so their lines are simplified. No shape is missing.`;
  }

  /** Fetch and draw the whole feed. Skipped entirely while the map is hidden. */
  async refresh(): Promise<void> {
    if (!this.isVisible()) return;

    // A load arriving mid-draw abandons the previous feed's layers rather than
    // racing them onto the map after the new feed has already been drawn.
    this.drawing?.abort();
    const controller = new AbortController();
    this.drawing = controller;
    this.simplifiedLayers.clear();
    this.state.routeShapes.clear();

    for (const id of SOURCE_IDS) await this.setSourceData(id, EMPTY_FEATURE_COLLECTION);

    try {
      for (const kind of LAYER_ORDER) await this.drawLayer(kind, controller.signal);
      this.state.mapDataLoaded = true;
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
    this.map.remove();
  }
}
