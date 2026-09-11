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

**DuckDB reads the CSVs in place.** GTFS feeds arrive as zipped CSV, and the
question is always "look at this feed now". An import step would add a wait
before the first query and a copy of the data on disk. `read_csv` over the
extracted files gives indexed-feeling queries with neither.

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
report distinguishes two per-file timings because they mean different things:
registering a view is `CREATE VIEW` alone, which DuckDB evaluates lazily and so
costs almost nothing, while counting rows is the `COUNT(*)` in `table_summaries`
and is the first and only time the CSV is truly read. A single "load time" per
file would hide that, and the honest answer to "why was this feed slow" is
nearly always one file's count, not its registration. Forcing an extra scan per
file would give a cleaner throughput number at the price of making every load
slower, which is the wrong trade for a tool whose point is opening a feed now.

**The metrics are collected in `core/` but published from `server/`.** `core`
stays framework-free, so `feed.py` accumulates plain dataclasses
(`FeedStats`, `FileStats`) and `server/models.py` turns them into the pydantic
shapes the OpenAPI document declares - the same split as everything else here.

**The feed lives on the app instance**, not in a module global, so tests can
build isolated apps and two servers in one process do not share state. A load
that fails leaves the previous feed working: the new feed is opened before the
old one is closed.
