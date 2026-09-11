# Architecture

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Query engine | [DuckDB](https://duckdb.org) | Reads CSV directly with real SQL, indexes nothing, loads nothing. Opening a feed costs the time to declare a view, not the time to import a database. |
| API | [FastAPI](https://fastapi.tiangolo.com) + uvicorn | Generates the OpenAPI document that defines the contract the frontend implements. |
| Frontend | TypeScript, built with [Vite](https://vite.dev), no framework | The UI is a table and a map; a framework would add a dependency the tool does not need, and plain modules keep the door open to shipping it as a custom element. |
| Map | [MapLibre GL JS](https://maplibre.org) | Same renderer as mobilitydatabase.org, so the two look alike. |
| Basemap | [OpenFreeMap](https://openfreemap.org) Positron, configurable | Keyless and unmetered, and self-hostable if the map ever has to work offline. |
| Packaging | hatchling | Ships the schema document and the built frontend as package data. |

## Layers

```
gtfs-garage <feed.zip>
        │
        ▼
   cli.py ──────────────► server/app.py  create_app()
                                │
                                ├── server/state.py    FeedRegistry: the one loaded feed
                                ├── server/routes.py   HTTP only: validate, delegate, map errors
                                └── server/models.py   pydantic = the published contract
                                            │
                                            ▼
                                  core/  (no web framework)
                                     ├── feed.py      GTFS files → DuckDB views
                                     ├── schema.py    reads data/gtfs-schema.json
                                     ├── filters.py   UI filters → parameterised SQL
                                     ├── queries.py   table summaries, pages, distinct values
                                     └── geojson.py   DuckDB rows → GeoJSON
```

The rule that makes the rest work: **nothing under `core/` imports a web
framework.** That is what lets another project depend on the query layer without
inheriting FastAPI, and `tests/test_layering.py` enforces it rather than trusting
it.

## Request flow

Opening `trips` filtered to one route:

1. `GET /api/table/trips?filters=[{"column":"route_id","op":"eq","value":"R1"}]`
2. `routes.py` parses the JSON, rejects anything that is not a list, and hands
   plain values to `core.queries.query_table`.
3. `filters.build_where` turns the filter list into `WHERE "route_id" = ?` with
   the value bound as a parameter. Column names are checked against the table's
   real columns, never interpolated from input.
4. `query_table` counts matches, then selects one page from the DuckDB view.
5. The frontend renders the rows and, for every column the server marked as a
   foreign key, renders the value as a link.

## Design decisions

**The feed is converted to Parquet at load, having previously been read as CSV
in place.** The original reasoning was that an import step would add a wait
before the first query and a second copy on disk. Measuring a 4.5 GB feed
showed both halves of that to be wrong. The conversion takes about six
seconds, and Parquet is roughly *twenty times smaller* than the CSV it replaces,
so the extracted files are deleted afterwards and the feed ends up occupying far
less disk, not more. What it buys is large: a CSV has to be re-parsed end to end
for every `COUNT(*)`, which is why paging a 64-million-row `stop_times` cost
about two seconds per page turn, while Parquet carries its row count in the
footer and reads only the columns a query names - the same counts drop to about
five milliseconds. `--no-parquet` keeps the read-in-place behaviour for anyone
who wants it. Only files the tool extracted itself are deleted; a feed opened
from a folder reads the user's own files and those are never touched.

**Every column is read as text** (`ALL_VARCHAR = TRUE`). A feed with a malformed
number in one row still opens; type errors are something you want to *see* in an
inspection tool, not something that should stop it loading.

**Empty fields become NULL** (`NULLSTR = ''`). This has one consequence worth
knowing: `column = ''` matches nothing, so the filter layer rewrites `= (empty)`
into `IS NULL OR = ''`. Skipping that made the "(empty)" picklist entry return
zero rows despite reporting a count.

**A cursor per request.** A DuckDB connection cannot serve queries issued
concurrently from different threads — results come back empty or wrong. Every
read takes `feed.cursor()`, a fresh cursor over the same in-memory database. Keep
this pattern in new code.

**Map layers stream as newline-delimited JSON.** A large feed is half a
million stops and ten million shape vertices - about 411 MB of GeoJSON, which
was fetched as three concurrent whole-document requests and parsed on the
browser's main thread. That crashed the tab. The layers now go out as a header
line carrying the total, then batches of features, so DuckDB scans each file
once and the map paints as the data arrives. Paging with offsets would have
meant one scan per page instead of one in total. With `GZipMiddleware` the whole
geometry is about 45 MB on the wire, so most of the problem was never size as
such - it was uncompressed, unchunked, and parsed in one go.

### Performance guards

Four regressions reached users before any of this existed: a load that froze the
whole server, a file scanned twice per map draw, unbounded map payloads, and a
tab killed by its own memory. Each is a structural property, so each is asserted
rather than trusted. `tests/test_performance_guards.py` runs in the default
suite and names, per test, the defect it prevents.

| Asserted | Because |
|---|---|
| no endpoint is `async def` | a blocking coroutine handler runs on the event loop and starves every other request |
| a layer walks `shapes` once | `routes_geojson` used to re-query it by id, reading the file twice |
| query count is identical across feed sizes | a per-shape lookup is invisible on a fixture and fatal on a real feed |
| both line layers share one vertex budget | a budget each silently permits twice the geometry |
| stop features carry exactly `stop_id` and `stop_name` | one unread property is a string per stop, and feeds have hundreds of thousands |
| layers are NDJSON and gzipped | buffering or sending raw is hundreds of MB the browser cannot take |
| redraws are logarithmic in layer size (`web/src/map/redraw.test.ts`) | `setData` re-indexes everything, so redrawing on a timer is quadratic |
| drawing the map adds under `MAX_MAP_HEAP_MB` (`tests/browser/`) | the crash was heap, which no server-side test can see |

Two things learned writing them, worth keeping:

**Assert the delta, not the total.** The browser guard first asserted total tab
heap under a ceiling. Every regression tried still passed, because most of the
tab is MapLibre, the basemap and the page. It now measures the tab with the map
hidden, draws it, and asserts the difference - where the geometry is the
majority of the number and a doubling fails.

**A guard is only worth keeping if it fails.** Each was checked by reintroducing
the defect it describes and confirming the failure. That caught two tests of my
own that asserted something trivially true, and one that injected a "regression"
which turned out not to cost anything: storing a layer's features in `AppState`
adds nothing, because `setData` already makes MapLibre retain the same object.

Timing is deliberately not asserted. `scripts/benchmark.py` measures load,
layer-build and paging times against a generated feed and prints a table into
the pull request's job summary, where a reviewer can compare it against the same
table on `main`. It never fails: a shared runner varies enough that any
threshold either flakes or is too loose to catch anything.

### When the map draws less than the feed contains

Route and shape geometry is thinned when a feed exceeds `MAX_MAP_VERTICES`
(`core/geojson.py`), currently **600,000 vertices**. A vertex is one row of
`shapes.txt`, so this is a threshold you can read straight off the sidebar. The
rule is:

```
step = ceil(rows_in_shapes_txt / MAX_MAP_VERTICES)   # every step-th point is kept
```

| Rows in `shapes.txt` | Step | Vertices drawn |
|---|---|---|
| up to 600,000 | 1 | all of them - the feed exactly |
| 1,200,000 | 2 | ~600,000 |
| 6,000,000 | 10 | ~600,000 |
| 10,435,496 (DELFI Germany) | 18 | ~580,000 |
| 20,000,000 | 34 | ~588,000 |

**One budget for the whole map, not one per layer.** The `routes` and `shapes`
layers are both drawn from `shapes.txt` into the same browser heap, so they
share a single step. Budgeting them separately quietly allowed twice the
intended geometry, which is how a tab still reached a gigabyte and died. The
`stops` layer is never thinned at any size: a stop is one point, so half a
million of them cost far less than the lines do.

So the observable behaviour is: **a feed with 600,000 shape rows or fewer is
drawn exactly; past that, lines lose intermediate points in proportion and
nothing else changes.** No shape, stop or route is ever omitted at any size, and
every line keeps its first and last point and at least two points. The step
travels in each layer's stream header and the map states which layers were
simplified, so a coarse line is never passed off as the feed's own geometry.

Row counts change nothing else. Table paging, filters, counts and the load
report behave identically at every size.

**Why 600,000.** The ceiling is what a browser survives, not a preference.
Measured on the 4.5 GB DELFI feed: drawing every vertex crashes the tab
outright. At a million per layer the map completed but peaked near a gigabyte of
JS heap, and opening a table afterwards was still enough to kill it. At 600,000
for the map as a whole the same feed peaks around 590 MB while drawing and
settles near 370 MB with every layer up, and survives browsing the largest
tables. Re-measure before raising it.

Two things that cost memory for nothing were removed rather than budgeted for:
`location_type` and `parent_station` were sent for every stop and read by
nothing, and the entire routes collection was retained in `AppState` to answer a
single id lookup that two ids per route now answer.

Deduplicating near-identical shapes would raise the effective detail for free
and is the obvious next step: a large feed emits a distinct `shape_id` per
trip pattern, so many of its shapes are the same corridor drawn again.

**A feed is borrowed for the length of a request, not just grabbed.** Loading a
feed replaces the previous one, which closes its DuckDB connection and deletes
the files behind it. `FeedRegistry.reading()` counts readers so a replaced feed
survives until the last request using it has finished. This was latent while
`POST /api/load` was an `async def` that held the event loop - nothing else ran
concurrently to be broken. Making the load run in a worker thread fixed the
frozen interface and made this reachable, and streaming responses make it
sharper still, because their cursor is still in use after the handler returns.

**GeoJSON, not vector tiles.** mobilitydatabase.org serves pre-built PMTiles,
which suits datasets published ahead of time. This tool opens whatever feed you
hand it, so building tiles would mean running Tippecanoe on every load. MapLibre
renders GeoJSON natively, which keeps the same look with no build step. If a feed
ever proves too large to draw this way, generating real tiles is the upgrade path.

**The map is self-contained.** Route geometry comes from the feed's own
`shapes.txt`, joined through `trips` to pick a representative shape per route and
coloured with the feed's `route_color`. Only two things cross the network: the
MapLibre library (a CDN script) and the basemap tiles. Neither involves
mobilitydatabase; what was borrowed is the styling recipe, not the data.

**The basemap is a setting, and every preset is keyless.** Providers change
their terms - a watermark demanding an API key can appear on a service that was
previously open - so the tile source is configuration rather than a constant, and
`none` is a supported value. Attribution is declared alongside each preset
because it is a licence obligation under ODbL and CC BY, and an upstream style
may not carry any. A vector basemap is fetched and merged into the style rather
than referenced by URL, so the feed's layers still exist from the first frame.

**Links are resolved against the feed.** Most GTFS files are optional, so the
relationships in `data/gtfs-schema.json` are filtered against what the loaded
feed actually contains. A feed without `fare_rules.txt` is never offered a link
to it.

**Sources and layers are declared in the initial map style**, not added in a
`load` handler. `load` only fires after the first paint, so in a background tab —
where `requestAnimationFrame` never runs — layers added that way never exist and
the feed silently never reaches the map.

**Load metrics measure the work a load already does**, and never add any. The
report distinguishes two per-file timings because they mean different things.
Reading a file's header is the `CREATE VIEW` over `read_csv`: DuckDB resolves
the column list off the start of the file and stops there, so the cost barely
varies with how large the file is. Counting rows is the `COUNT(*)` in
`table_summaries`, and is the first and only time the CSV is read end to end -
the timing that actually scales. A single "load time" per file would hide that,
and the honest answer to "why was this feed slow" is nearly always one file's
count, not its header. The response field is still `register_ms`, which names
the mechanism; the interface labels it "Read headers", which names the effect.
Forcing an extra scan per file would give a cleaner throughput number at the
price of making every load slower, which is the wrong trade for a tool whose
point is opening a feed now.

**The metrics are collected in `core/` but published from `server/`.** `core`
stays framework-free, so `feed.py` accumulates plain dataclasses
(`FeedStats`, `FileStats`) and `server/models.py` turns them into the pydantic
shapes the OpenAPI document declares - the same split as everything else here.

**The feed lives on the app instance**, not in a module global, so tests can
build isolated apps and two servers in one process do not share state. A load
that fails leaves the previous feed working: the new feed is opened before the
old one is closed.
