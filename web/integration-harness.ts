/**
 * Mounts the viewer the way each integration does. See integration-harness.html.
 *
 * `?mode=` selects one:
 *
 * - `embedded`  a host's own page: no load dialog, no options menu, no map, and
 *               a back stack the viewer keeps to itself.
 * - `static`    Parquet read in the browser over range requests, no server at
 *               all. `?dataset=` says where the files are.
 * - `rest`      the default source against a GTFS Garage server, but mounted by
 *               a host rather than by the application.
 *
 * `window.harness` reports what was mounted, so the driver asserts against the
 * configuration it asked for rather than against what it hopes it got.
 */

import "maplibre-gl/dist/maplibre-gl.css";

import { browserHistory, mount, type ViewerOptions } from "./src/mount";
import { mapPart } from "./src/map-part";
import { ParquetSource } from "./src/sources/parquet";

const parameters = new URLSearchParams(location.search);
const mode = parameters.get("mode") ?? "embedded";
const dataset = parameters.get("dataset") ?? "/dataset";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

const configurations: Record<string, () => ViewerOptions> = {
  // What `docs/INTEGRATION.md` shows a host doing: the browse half and nothing
  // that belongs to the local application.
  embedded: () => ({ parts: { load: false, options: false } }),

  // The deployment behind the Mobility Database's public bucket: `{table}.parquet`
  // and a manifest on a static host, read by DuckDB-WASM over range requests.
  // With the map, which this source builds from the same Parquet - there is no
  // server in this configuration to ask for GeoJSON.
  static: () => ({
    source: new ParquetSource({ baseUrl: dataset, name: "dataset" }),
    map: mapPart,
    history: browserHistory(),
  }),

  // A host mounting the REST source itself, with a map, which is the
  // configuration closest to the application without being it.
  //
  // With the browser's own history, which is what a host whose page *is* the
  // viewer should pass: every view becomes a link, and Back walks them. The
  // embedded mode above deliberately does not - keeping the host's address bar
  // to itself is the thing that mode exists to demonstrate - so the two
  // together show both halves of the choice.
  rest: () => ({ parts: { load: false, options: false }, map: mapPart, history: browserHistory() }),
};

const build = configurations[mode];
if (!build) throw new Error(`Unknown harness mode: ${mode}`);

const options = build();
void mount(root, options).then((viewer) => {
  Object.assign(window as unknown as Record<string, unknown>, {
    harness: {
      mode,
      mounted: true,
      hasMap: Boolean(options.map),
      hasLoadDialog: options.parts?.load ?? false,
      hasOptionsMenu: options.parts?.options ?? false,
      /**
       * The source itself, so the conformance check can ask it for a payload
       * and compare that against the one the Python implementation produces
       * for the same feed. Two implementations of one answer only stay
       * equivalent if something checks.
       */
      source: options.source ?? null,
    },
    viewer,
  });
});
