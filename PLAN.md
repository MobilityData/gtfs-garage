# gtfs-garage: standalone local GTFS viewer (Python/DuckDB backend, MapLibre frontend)

## Context

Numbers can't be used to browse GTFS feeds: no cross-referencing between IDs across files (can't click a `trip_id` and jump to its `route_id`/`shape_id`), it chokes on large feeds, and there's no way to see stops/shapes/routes on a map or filter entities by field-level characteristics (e.g. trips with `continuous_pickup`/`continuous_drop_off` set — relevant to the seal-of-reliability/continuous-coverage work already in flight on this repo, per recent commits `3b90a247`, `cf1e38ce`).

The plan evolved through several checkpoints this session:
1. Evaluated existing tools first (QGIS + GTFS Loader plugin, GTFS-GO, node-gtfs, TransitLens). QGIS + GTFS Loader was the strongest open-source candidate (GeoPackage/SQLite backing, real map view), but cross-referencing/filtering there means writing raw SQL in DB Browser or QGIS's Query Builder — rejected as not user-friendly enough.
2. Started a custom local tool instead (Python + DuckDB + FastAPI + a browser UI), confirmed working end-to-end against a sample feed at `/Users/david/code/gtfs-garage`.
3. Considered whether GTFS files themselves should move to Parquet for web efficiency — the user has a related draft PR ([#1728](https://github.com/MobilityData/mobility-feed-api/pull/1728)) prototyping GTFS→Parquet + DuckDB-WASM + HTTP range requests for a future public `/en/gtfs-viewer` page. **Parked** — not part of this build (see below).
4. Reconsidered scope: this should be a fully independent tool/repo (not inside `mobility-feed-api`), usable from the command line, and built in a way that doesn't foreclose future reuse by `mobilitydatabase-web` — but **no integration work happens now**, only the standalone tool itself.

## Decision: what gets built now

A standalone local tool, own repo, **not** touching `mobility-feed-api` or `mobilitydatabase-web`:

- **Backend**: Python + DuckDB + FastAPI, run via `python run.py <feed.zip>` (already prototyped and working at `/Users/david/code/gtfs-garage` — reads GTFS `.txt` files directly as DuckDB views, no import/ETL step, so large feeds stay responsive). Filtering is done through a picklist/operator UI that builds parameterized queries server-side — the user never writes SQL, which is what disqualified the QGIS/DB Browser path.
- **Cross-referencing**: every FK-shaped column (`route_id`, `trip_id`, `shape_id`, `stop_id`, etc., per a hand-maintained schema map) renders as a clickable link that filters the target table to the matching row; primary-id columns additionally show "▸ related table" buttons (reverse lookups, e.g. from a route to its trips/fares) — already implemented in the prototype (`app/schema.py`, `app/filters.py`).
- **Map**: switch from the prototype's current Leaflet map to **MapLibre GL JS**, matching `mobilitydatabase-web`'s actual current `main` implementation (`src/app/components/GtfsVisualizationMap.tsx`, confirmed via `git diff origin/main`, not a stale/local branch) — same rendering engine and visual conventions:
  - Carto raster basemap tiles (`https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png`, dark variant available), not a vector basemap style.
  - Route lines colored from `route_color` (`concat '#' get route_color`), width varying by `route_type`, with a white/light outline layer beneath for contrast against the basemap.
  - Stops as circle layers (small radius, low opacity, `minzoom` gating so they only appear zoomed in) with a distinct highlight style (outer ring effect) for the "show on map" actions.
  - Pin `maplibre-gl` to `^5.7.0` (matches `mobilitydatabase-web`'s pinned version) for consistency, in case of future reuse.
  - **Deviation from `mobilitydatabase-web`, deliberately**: use plain **GeoJSON sources** instead of PMTiles vector tiles. PMTiles requires the `pmtiles_builder`/Tippecanoe build pipeline (GCS-oriented, meant for pre-built production datasets) — not practical for instantly loading an arbitrary local GTFS zip a user just picked. MapLibre GL renders GeoJSON sources natively, so this keeps the same rendering engine and visual style without requiring a heavyweight tile-build step. (If very large feeds ever make GeoJSON rendering too slow, generating real PMTiles via the existing `pmtiles_builder` code is the documented upgrade path — not needed for the initial build.)
- **Not built now** (explicitly out of scope per user): any Web Component packaging, npm publishing, or actual integration into `mobilitydatabase-web`. The tool should simply avoid painting itself into a corner — e.g. keep the frontend as a self-contained static bundle rather than something inseparable from the FastAPI process — but no packaging/distribution work happens in this pass.

## Rename: gtfs-explorer -> gtfs-garage

The working name collided with an existing project ([chuangbo/gtfs-explorer](https://github.com/chuangbo/gtfs-explorer)). `gtfs-garage` is free on PyPI, npm and as a repo name, is transit-native (a garage is where vehicles are parked, inspected and worked on), and accommodates edit features later without a third rename. Names to avoid for the same collision reason: `gtfs-lens`/`feedlens` (TransitLens is an active commercial browser-based GTFS viewer) and `gtfs-studio` ([gtfs.studio](https://gtfs.studio/) is an existing online GTFS editor).

Rename is contained — the directory plus 9 string references in 6 files:
- `run.py` (argparse description, startup banner)
- `README.md` (title)
- `app/main.py` (`FastAPI(title=...)`, temp-dir prefix `gtfs-explorer-upload-`)
- `app/gtfs_db.py` (temp-dir prefix `gtfs-explorer-`)
- `app/static/index.html` (`<title>`, `<h1>`)
- `app/static/app.js` (localStorage key `gtfs-explorer.map-visible`, read + write)

Two notes: changing the localStorage key resets the saved show/hide-map preference once (it just reverts to shown — not worth a migration), and the locally running server on port 8811 was started from the old path, so it needs restarting from the renamed directory.

## Existing prototype to build on

`/Users/david/code/gtfs-garage` already has a working DuckDB-backed FastAPI app tested against `functions-python/test_data/gtfs-sample.zip`:
- `app/gtfs_db.py` — loads a GTFS zip/folder into DuckDB views (`read_csv`, `ALL_VARCHAR=TRUE`), one view per `.txt` file.
- `app/schema.py` — hand-maintained FK map, primary-id-per-table map, and enum-like column list (drives the picklist filter UI and the FK/related-table links).
- `app/filters.py` — turns UI-built filters into parameterized SQL (`eq`/`ne`/`contains`/`in`/`is_empty`/`is_not_empty`), never raw user SQL.
- `app/geojson.py` — builds stops/shapes/routes GeoJSON FeatureCollections from the DuckDB views (this is what needs to be fed into MapLibre instead of Leaflet).
- `app/main.py` / `run.py` — FastAPI app + CLI entrypoint; **note**: a real bug was found and fixed here — DuckDB connections aren't safe for concurrent access from multiple request threads, so every query goes through `feed.cursor()` (a fresh cursor per request), not the shared `feed.con` directly. Keep this pattern for any new endpoints.
- `app/static/` — the current Leaflet-based frontend; this is the part to rework for MapLibre.

## Verification

- Run `python run.py <feed.zip>` against both the existing small sample feed and a real large feed, confirm the page loads promptly and table pagination/filtering stays responsive.
- Confirm the MapLibre map renders stops and route/shape lines with styling that visually matches `mobilitydatabase-web`'s conventions (colors from `route_color`, width by `route_type`, stop circles gated by zoom).
- Re-verify the interaction flows already validated in the Leaflet version still work after the swap: clicking an FK column jumps to the related table pre-filtered, "▸ related table" buttons work, the map highlight buttons (📍/🧭/🚌) still highlight the right feature.
- Filter a field like `continuous_pickup` end-to-end through the picklist UI (not raw SQL) to confirm the original Numbers-replacement requirement is actually met.

## How this relates to Parquet and PR #1728 (analysis only, no action taken)

Established 2026-09-09. There are three artifacts in play, and they are the native and WASM halves of one architecture rather than competing efforts:

| | `gtfs-garage` (this build) | PR [#1728](https://github.com/MobilityData/mobility-feed-api/pull/1728) (draft) | `gtfs-viewer-poc` branch in `mobilitydatabase-web` |
|---|---|---|---|
| Engine | DuckDB native (Python) | DuckDB → per-table Parquet, sorted so row-group stats allow range-skipping | DuckDB-WASM (intended consumer) |
| Data | Local `.txt` read in place | Converted Parquet + a byte-range/CORS dev server | Remote Parquet over HTTP range requests |
| Audience | Local, arbitrary feeds, full size | (plumbing between the two) | Public site visitors, medium-sized feeds |

Parquet is a *web-delivery* optimization — its wins are transfer size and fetching only the byte ranges a query touches, both of which only pay off when the data is remote. It buys nothing for a local tool reading files already on disk, which is why reading the CSVs in place with `read_csv` was the right call here.

Three things `gtfs-garage` already solved that a WASM viewer would otherwise re-solve from scratch: the GTFS relationship map (`app/schema.py` — foreign keys, primary ids, enum-like columns, reverse lookups), the filter semantics in `app/filters.py` (notably that empty CSV fields load as NULL, so `= (empty)` must mean `IS NULL OR = ''`), and resolving links against the files a feed actually contains.

Cheapest bridge if it's ever wanted: DuckDB reads Parquet natively, so having `app/gtfs_db.py` use `read_parquet(...)` when the source contains `.parquet` files (~10 lines) would let `gtfs-garage` open PR #1728's converter output directly. That has real value because the PR currently records no size or performance numbers and has nothing checking that the conversion preserved the data.

## Direction: shared components across local and mobilitydatabase

### The contract

The REST API already built in `app/main.py` is the interface. Freeze its shape and define one narrow data-source contract the UI depends on:

```ts
interface GtfsSource {
  tables(): Promise<TableInfo[]>                              // names, row counts, columns + link metadata
  query(table, filters, page, pageSize): Promise<Page>        // rows + total
  distinct(table, column, limit): Promise<ValueCount[]>       // picklist values
  geojson(kind, ids?): Promise<FeatureCollection>             // stops | shapes | routes
}
```

Two implementations, no UI changes between them:
- **`RestSource`** — calls the local FastAPI endpoints (already exist and already return these shapes).
- **`DuckDbWasmSource`** — runs the equivalent DuckDB SQL in-browser against PR #1728's Parquet over HTTP range requests.

Both sides execute DuckDB SQL, so query semantics stay identical rather than merely similar.

### The three shared artifacts

1. **`schema/gtfs-schema.json`** — single source of truth for GTFS semantics currently hardcoded in `app/schema.py`: foreign keys, primary id per table, enum-like columns. Python loads it; TypeScript loads it. Language-neutral, no build coupling.
2. **`<gtfs-viewer>` Web Component** — the UI (table, FK links, filter builder, pagination, back/history, MapLibre map) as a framework-agnostic custom element. Chosen over a React component library because `mobilitydatabase-web` (Next 16 / React 19 / MUI 7) and `mobilitydatabase-operations-web` (Next 15 / React 18 / MUI 5) aren't on matching majors — a custom element sidesteps version lockstep entirely. React 19 has full custom-element support, so mounting is clean.
3. **The `GtfsSource` adapters** — the only code that differs between the two deployments.

**Styling decision**: use light DOM (no shadow root) plus CSS custom properties for colors/fonts, so `mobilitydatabase-web` can theme the component to match MUI. A shadow root would isolate it from the host's styles and make it look foreign on the site.

### Repo layout (`gtfs-garage`)

```
schema/gtfs-schema.json      # shared semantics, consumed by both languages
app/                          # Python: FastAPI + native DuckDB (local server)
web/
  src/component/             # <gtfs-viewer> custom element
  src/sources/rest.ts        # local adapter
  src/sources/duckdb-wasm.ts # browser adapter (Parquet + range requests)
  dist/gtfs-viewer.js        # built bundle - served locally, imported by the web app
```

Locally, FastAPI serves `dist/gtfs-viewer.js` plus a thin page. In `mobilitydatabase-web`, the same bundle is imported (git dependency first — no publishing infra exists in any of these repos — graduating to npm once stable).

### Phasing, smallest useful step first

1. **Extract `schema/gtfs-schema.json`** and have `app/schema.py` load it. Small, zero risk, immediately establishes the single source of truth before anything depends on it.
2. **Port the current vanilla-JS frontend to the TS Web Component + `RestSource`**, with `gtfs-garage` serving the built bundle. The local tool must behave exactly as it does today; this is a refactor with no user-visible change. No web-repo changes.
3. **Add `DuckDbWasmSource`** against PR #1728's Parquet output and run the *same* component against it. This is the proof point: one UI, two data paths, verified before anything touches production.
4. **Only then**, as a separate decision, embed in `mobilitydatabase-web`.

### Non-goals and honest risks

- Not building an editor; the component is read-only.
- Phase 2 is a real rewrite of a frontend that already works — the payoff is reuse, and it should be judged on whether phase 4 is actually wanted.
- DuckDB-WASM is memory-bound in the browser, so the web embed targets medium feeds; large-feed inspection stays the local tool's job. The component should surface that limit rather than hang.
- `maplibre-gl` stays pinned at `^5.7.0` to match `mobilitydatabase-web`.

### Verification

- Phase 1: existing endpoints return identical `/api/tables` output before and after the JSON extraction (diff the JSON).
- Phase 2: re-run this session's checks against the component build — table switching, FK jump, `▸ related` reverse lookup, filter picklist incl. the `(empty)` case, back/forward history, map toggle.
- Phase 3: point both adapters at the same feed (raw `.txt` vs converted Parquet) and diff `tables()`/`query()` output — this doubles as the correctness check PR #1728 currently lacks.
