# GTFS Garage

A local GTFS feed browser. Point it at a feed and get a table view where IDs are
clickable across files, a filter builder that never asks you to write SQL, and a
map of stops and route shapes.

Built for inspecting feeds that are too big or too cross-referenced for a
spreadsheet.

## Install

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```

## Run

```bash
./.venv/bin/python run.py path/to/feed.zip
```

Opens http://127.0.0.1:8811 in your browser. Accepts a `.zip` or an
already-extracted folder; zips with the `.txt` files nested inside a subfolder
work too. You can also start it with no argument and load a feed from the page
(drag a zip in, or paste a local path).

Options: `--port <n>`, `--no-browser`.

## What it does

- **Cross-references IDs.** Any foreign-key column (`route_id`, `trip_id`,
  `shape_id`, `stop_id`, `service_id`, …) is a link: click it to jump to the
  referenced table, filtered to that row. Primary-id columns also get
  `▸ table` buttons for the reverse direction, e.g. from a route straight to the
  trips that use it.
- **Filters without SQL.** Pick a column, an operator (`is`, `is not`,
  `contains`, `is one of`, `is empty`, `is not empty`) and a value. For columns
  GTFS defines as enumerations (`continuous_pickup`, `route_type`,
  `wheelchair_boarding`, …) the value box becomes a picklist of what's actually
  in the feed, with row counts.
- **Maps what you're looking at.** Stops and route shapes render on the map;
  per-row buttons highlight a specific stop (📍), shape (🧭) or route (🚌).
- **Goes back.** Every table switch, filter change and page turn is a history
  entry, so `← Back` (and the browser's own back/forward) returns you to the
  exact previous view, filters included. The URL carries that state too, so a
  particular filtered view can be reloaded or shared.
- **Stays responsive on large feeds.** DuckDB queries the `.txt` files directly
  as views — there's no import or conversion step, and only the current page of
  rows is ever materialized.

## Layout

```
schema/
  gtfs-schema.json  GTFS foreign keys, primary ids, enum-like columns
app/
  gtfs_db.py   feed -> DuckDB views (one per .txt file)
  schema.py    loads schema/gtfs-schema.json
  filters.py   UI filters -> parameterized SQL
  geojson.py   DuckDB views -> GeoJSON for the map
  main.py      FastAPI endpoints
  static/      frontend (MapLibre GL + vanilla JS)
run.py         CLI entrypoint
```

Map styling mirrors mobilitydatabase.org's own GTFS map (Carto basemap, route
colors from `route_color`, line width by `route_type`, white casing under the
colored line) so the two read the same way. It differs in using plain GeoJSON
sources instead of PMTiles, since building tiles would need Tippecanoe on every
load — fine for a tool that opens arbitrary local feeds on demand.

`schema/gtfs-schema.json` holds the GTFS relationships (foreign keys, primary id
per table, enum-like columns) rather than the Python source, so a JavaScript or
TypeScript viewer can consume the same definitions instead of keeping a second
copy that drifts.

## Notes

DuckDB connections can't serve concurrent queries from multiple request threads,
so every endpoint takes a fresh cursor via `feed.cursor()`. Keep that pattern for
new endpoints, or you get intermittent empty results under concurrent requests.
