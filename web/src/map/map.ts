import type { Dom } from "../dom";
import type { RestSource } from "../sources/rest";
import type { FeatureCollection, GeoJsonKind } from "../sources/types";
import type { AppState } from "../state";
import { resolveBasemap } from "./basemap";
import { bboxOf } from "./geo";
import { buildStyle, EMPTY_FEATURE_COLLECTION, SOURCE_IDS, type SourceId } from "./layers";
import { createRedrawSchedule } from "./redraw";

const MAP_VISIBLE_KEY = "gtfs-garage.map-visible";



/** Drawn in this order: the coloured routes first, so something useful appears
 * within a second even on a feed whose shapes take half a minute. */
const LAYER_ORDER: GeoJsonKind[] = ["routes", "stops", "shapes"];

const LAYER_NOUNS: Record<GeoJsonKind, string> = {
  routes: "routes",
  stops: "stops",
  shapes: "shapes",
};

/** MapLibre is loaded from a CDN script tag, so it arrives as a global. */
declare const maplibregl: any;

export class MapController {
  private readonly map: any;
  private readonly ready: Promise<void>;

  /** A vector basemap has to be fetched before the map is constructed. */
  static async create(
    dom: Dom,
    state: AppState,
    source: RestSource,
    basemap?: string | null,
  ): Promise<MapController> {
    return new MapController(dom, state, source, await buildStyle(resolveBasemap(basemap)));
  }

  /** Cancels an in-flight refresh when a new feed arrives mid-draw. */
  private drawing: AbortController | null = null;

  /** Layers the server thinned to fit, and by how much. */
  private readonly simplifiedLayers = new Map<GeoJsonKind, number>();

  private constructor(
    private readonly dom: Dom,
    private readonly state: AppState,
    private readonly source: RestSource,
    style: Record<string, unknown>,
  ) {
    this.map = new maplibregl.Map({
      container: "map",
      center: [0, 20],
      zoom: 1,
      attributionControl: { compact: true },
      style,
    });
    this.map.addControl(new maplibregl.NavigationControl(), "top-right");
    this.map.addControl(new maplibregl.ScaleControl());

    this.map.on("click", "stops", (event: any) => {
      const properties = event.features[0].properties;
      new maplibregl.Popup()
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

  async highlight(collection: FeatureCollection, options: { point?: boolean } = {}): Promise<void> {
    // Asked to see something on the map, so show the map.
    if (!this.isVisible()) this.setVisible(true);
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
}
