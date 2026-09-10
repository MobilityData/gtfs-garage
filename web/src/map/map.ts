import { el } from "../dom";
import type { FeatureCollection, GtfsSource } from "../sources/types";
import type { AppState } from "../state";
import { bboxOf } from "./geo";
import { buildStyle, EMPTY_FEATURE_COLLECTION, SOURCE_IDS, type SourceId } from "./layers";

const MAP_VISIBLE_KEY = "gtfs-garage.map-visible";

/** MapLibre is loaded from a CDN script tag, so it arrives as a global. */
declare const maplibregl: any;

export class MapController {
  private readonly map: any;
  private readonly ready: Promise<void>;

  constructor(
    private readonly state: AppState,
    private readonly source: GtfsSource,
  ) {
    this.map = new maplibregl.Map({
      container: "map",
      center: [0, 20],
      zoom: 1,
      attributionControl: { compact: true },
      style: buildStyle(),
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

    el("toggle-map-btn").addEventListener("click", () => this.setVisible(!this.isVisible()));
  }

  isVisible(): boolean {
    return !el("map-pane").hidden;
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
    el("map-pane").hidden = !visible;
    el("toggle-map-btn").textContent = visible ? "Hide map" : "Show map";
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

  /** Fetch and draw the whole feed. Skipped entirely while the map is hidden. */
  async refresh(): Promise<void> {
    if (!this.isVisible()) return;

    const [routes, stops, shapes] = await Promise.all([
      this.source.geojson("routes"),
      this.source.geojson("stops"),
      this.source.geojson("shapes"),
    ]);

    this.state.routesGeojson = routes;
    await this.setSourceData("routes", routes);
    await this.setSourceData("stops", stops);

    // Only draw plain shapes that no coloured route already covers.
    const claimed = new Set(routes.features.map((f) => f.properties.shape_id));
    await this.setSourceData("shapes", {
      type: "FeatureCollection",
      features: shapes.features.filter((f) => !claimed.has(f.properties.shape_id)),
    });
    await this.setSourceData("highlight", EMPTY_FEATURE_COLLECTION);

    const target = routes.features.length
      ? routes
      : shapes.features.length
        ? shapes
        : stops;
    this.fitTo(target, 13);
    this.state.mapDataLoaded = true;
  }

  async clear(): Promise<void> {
    for (const id of SOURCE_IDS) await this.setSourceData(id, EMPTY_FEATURE_COLLECTION);
  }
}
