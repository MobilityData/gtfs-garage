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

### What is built to be used from outside

Three seams exist for reuse, and each is enforced rather than merely intended -
which is the only reason to trust them.

**The GTFS description.** `schema/gtfs.yaml` is the source — LinkML, one class
per file. It describes all 31 CSV files and 218 fields, and its field names and presence
agree exactly with `google/transit`'s published reference.

GTFS's facts are carried by LinkML's own constructs, not by annotations: field
types are `types` with a `range` (and `exact_mappings` naming the GTFS field
type), enumerations are `enums`, foreign keys are a `range` pointing at the
referenced class, primary keys are `identifier` or — for the 12 files GTFS keys
on more than one column — `unique_keys`, and conditional requirement is 24
`rules`. Using the native constructs is what lets `scripts/check-schema.sh`
validate the schema at all; annotations are opaque to LinkML, so a schema made
of them cannot be checked.

Two conditions in GTFS are not a property of a single row — "required when the
feed has more than one agency" quantifies over `agency.txt` — and a per-row rule
cannot express them. Those six fields carry the condition in words and are
flagged `conditionEnforced: false`, rather than being written as a rule that
would look authoritative and check nothing.

`data/gtfs-schema.json` is generated from it by `scripts/build-schema-json.sh`
and committed. Two reasons it is a separate artifact rather than a duplicate:

- **It is what gets published.** LinkML is an authoring format; a flat JSON is
  what another project consumes, the way `gbfs-json-schema` publishes JSON
  Schema and generates bindings rather than shipping its models. A consumer
  wanting GTFS's foreign keys should not need a YAML parser, let alone LinkML.
- **It ships in the wheel.** `schema/` is not package data, and reading YAML at
  runtime would add a dependency to a package that other projects embed - it
  has four.

Generated-and-committed can drift, so
`test_the_packaged_json_matches_the_linkml_source` regenerates and compares.
Nothing in `web/` reads either file today: the frontend receives schema facts
through `ColumnInfo` on `/api/tables`, so the server is the only reader.

**`gtfs_garage.core`** — feed loading, filters to SQL, table summaries,
pagination, distinct values, GeoJSON. What reusing it buys over rewriting is the
parts that are easy to get subtly wrong: the null-versus-empty filter semantics,
resolving links only against files a feed actually contains, and the
cursor-per-request rule that a shared DuckDB connection otherwise breaks.

**`GtfsSource`** (`web/src/sources/types.ts`) — the interface the whole UI is
written against. `RestSource` implements it over this server; any other
implementation drives the same interface unchanged, which is what makes the
viewer embeddable somewhere that has no Python server at all.

How a particular project should consume these is that project's decision and is
documented where that work happens, not here - a description of someone else's
architecture written from inside this repository goes stale without anyone
noticing.

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

Timing is deliberately not asserted. `scripts/benchmark.sh` measures a generated
feed and never fails: a shared runner varies enough that any threshold either
flakes or is too loose to catch anything.

**The benchmark is a comparison, not a number.** An absolute figure on a pull
request is unreadable - nobody goes and finds `main`'s run to weigh it against.
So the `benchmark` job measures the branch *and* its merge base **on the same
runner, seconds apart**, and posts the difference as a comment that updates in
place. Same-runner is the whole point: a baseline recorded on another machine
differs by more than most real regressions, which makes cross-run timings worth
nothing.

Three things make the report honest:

- **Exact metrics are separated from timings.** Payload bytes, feature counts,
  vertex counts and row totals are deterministic for a fixed input, so any
  change in one is a real change and is flagged. Timings are shown but labelled
  as moving with the runner. Mixing the two is what makes benchmark comments get
  ignored.
- **The harness is pinned, only `src/` varies.** `benchmark.py`, its comparison
  script and `tests/conftest.py`'s feed generator are copied to `/tmp` before the
  base is checked out, and run from there. Otherwise a branch that changes the
  generated feed would be comparing two different experiments - and a script the
  branch *adds* does not exist in the base checkout at all.
- **A base that will not benchmark is reported, not hidden.** When the base
  predates a metric the branch adds, its run fails; the comment then shows the
  branch alone and says why.

The comment is best-effort. A pull request from a fork, and every Dependabot one,
gets a read-only token that `permissions:` cannot elevate, so commenting fails
there - which is why the report goes to the job summary first and the numbers
survive either way. `pull_request_target` would fix that and is deliberately not
used: it runs with a writable token against a branch the repository does not
control.

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

**Load metrics measure the work a load already does**, and never add any.
Forcing an extra scan per file would give a cleaner throughput number at the
price of making every load slower, which is the wrong trade for a tool whose
point is opening a feed now.

The phase list reports each phase against the storage it actually ran on, in
order: unzip, read headers (`CREATE VIEW` over `read_csv`, which resolves the
column list off the start of each CSV), convert, then count rows.

**The per-file table shows one timing, not two.** It used to show the header
read beside the row count, which stopped making sense once conversion became the
default. Counting rows no longer reads anything: Parquet keeps the row count in
its footer, so `COUNT(*)` is a flat fraction of a millisecond whatever the row
count - on a 160,000-row file, 0.18 ms converted against 30 ms as CSV. Worse,
the two were measured against *different* storage, since the header read happens
on the CSV before conversion and the count on the Parquet after it, so reading
them side by side told you nothing.

What the column shows now is what the load actually did to that file: its
conversion time by default, or its row count under `--no-parquet`, with the
heading changing to match. A file that would not convert keeps its CSV view and
shows an em dash rather than borrowing the other mode's number.

**The metrics are collected in `core/` but published from `server/`.** `core`
stays framework-free, so `feed.py` accumulates plain dataclasses
(`FeedStats`, `FileStats`) and `server/models.py` turns them into the pydantic
shapes the OpenAPI document declares - the same split as everything else here.

**The feed lives on the app instance**, not in a module global, so tests can
build isolated apps and two servers in one process do not share state. A load
that fails leaves the previous feed working: the new feed is opened before the
old one is closed.
