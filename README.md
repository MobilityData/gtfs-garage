# GTFS Garage

A local browser for GTFS feeds. Open a feed and get tables whose IDs are
clickable across files, a filter builder that never asks you to write SQL, and a
map of the stops and route shapes.

Built for feeds that are too large or too cross-referenced to inspect in a
spreadsheet: DuckDB queries the `.txt` files where they sit, so there is no
import step and only the rows on screen are ever materialised.

- **Follow an ID across files.** Every foreign key (`route_id`, `trip_id`,
  `shape_id`, `stop_id`, `service_id`, …) is a link to the referenced row, and a
  table's own id column offers the reverse direction — from a route straight to
  the trips that use it. Links to files a feed does not contain are not shown.
- **Filter without SQL.** Pick a column, an operator (`is`, `is not`,
  `contains`, `is one of`, `is empty`, `is not empty`) and a value. Columns GTFS
  defines as enumerations (`continuous_pickup`, `route_type`,
  `wheelchair_boarding`, …) offer a picklist of the values actually present,
  with counts.
- **See it on a map.** Stops and route shapes render from the feed's own
  `shapes.txt`, coloured by its `route_color`. Per-row buttons highlight a
  particular stop, shape or route. The map can be turned off, and while it is
  off none of its data is fetched.
- **Go back.** Every table switch, filter change and page turn is a history
  entry, so Back — in the app or the browser — returns to the previous view with
  its filters intact. The URL describes the view, so it can be reloaded or
  shared.

## Requirements

Python 3.11 or newer. Released packages ship with the interface already built,
so installing does not require Node. Node 22 or newer is needed only to work
from a source checkout, where the frontend has to be built once.

## Installation & Usage

```bash
pip install gtfs-garage
gtfs-garage path/to/feed.zip
```

That opens <http://127.0.0.1:8811>. The argument accepts a `.zip` or an
already-extracted folder, and zips that wrap their `.txt` files in a subfolder
work too. Omit it to pick a feed in the browser instead — drag a zip in, or
paste a local path.

```
gtfs-garage [--host HOST] [--port PORT] [--basemap NAME|URL] [--no-browser]
            [--version] [feed]
```

The map backdrop is configurable with `--basemap` or `$GTFS_GARAGE_BASEMAP`:
`openfreemap` (default), `esri`, `osm`, `carto`, `none`, or any raster tile
template or vector style URL. All presets except `carto` work without an API
key.

The Python API is usable on its own, without the server:

```python
from gtfs_garage.core import GtfsFeed, query_table

feed = GtfsFeed("path/to/feed.zip")
page = query_table(feed, "trips", [{"column": "route_id", "op": "eq", "value": "R1"}])
```

## Local development

One script sets up the Python environment, installs both sets of
dependencies, builds the interface and starts the tool. It is safe to re-run and
works from a fresh clone:

```bash
scripts/run-app.sh path/to/feed.zip
```

While working on the code, use hot-reload mode instead. Frontend edits appear
immediately and Python edits restart the API, so nothing is rebuilt to see a
change:

```bash
scripts/run-app.sh path/to/feed.zip --dev
```

`--help` lists the options (`--port`, `--basemap`, `--skip-install`,
`--no-browser`).

The frontend build output is not in version control, so a checkout has none
until it is built. Without it the API still runs and the page explains what to
do, rather than failing obscurely. The individual frontend commands live in
`web/`: `yarn dev`, `yarn build`, `yarn typecheck`, `yarn test`.

## Linter

```bash
scripts/lint-tests.sh   # check
scripts/lint-write.sh   # fix
```

flake8 and black at a line length of 120, matching MobilityData's other Python
components. `pre-commit install` wires the check into commits.

## Tests

```bash
scripts/tests.sh
```

pytest with branch coverage, which must stay at or above 80%.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the stack, the layers and why
  they are split the way they are.
- [docs/SHARING.md](docs/SHARING.md) — what other MobilityData projects can
  reuse from here, and how.

## License

Apache 2.0. See [LICENSE](LICENSE).
