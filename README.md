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
- **Open a feed from anywhere.** A `.zip` or an extracted folder, chosen from
  the page or dropped onto it, a local path, or a URL the tool downloads.
- **Filter without SQL.** Pick a column, an operator (`is`, `is not`,
  `contains`, `is one of`, `is empty`, `is not empty`) and a value. Columns GTFS
  defines as enumerations (`continuous_pickup`, `route_type`,
  `wheelchair_boarding`, …) offer a picklist of the values actually present,
  with counts.
- **See it on a map.** Stops and route shapes render from the feed's own
  `shapes.txt`, coloured by its `route_color`, and a flex feed's on-demand zones
  are drawn from `locations.geojson`. Per-row buttons highlight a particular
  stop, shape, route or zone. The map can be turned off, and while it is off
  none of its data is fetched.
- **Open a large feed.** A multi-gigabyte feed is converted once to a
  columnar store at load, so queries stay in milliseconds instead of re-reading
  gigabytes of CSV, and the map streams in progressively rather than arriving in
  one piece that no browser can hold. Every stop, route and shape is drawn at
  any size. Once `shapes.txt` passes 600,000 rows the map's lines start losing
  intermediate points in proportion, and the map says so; tables, filters and
  counts behave identically at every size.
- **See what it cost.** Every load reports its own timings and sizes: the
  download or upload, the unzip, the conversion, and per file the bytes on disk,
  the rows, and the time spent reading the header versus counting the rows. The header carries a one-line summary that opens
  into the full breakdown, largest file first.
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
work too. Omit it to pick a feed in the browser instead — drag a zip in, or give
a local path or a URL for the tool to download.

```
gtfs-garage [--host HOST] [--port PORT] [--basemap NAME|URL] [--no-browser]
            [--no-parquet] [--version] [feed]
```

At load the feed is rewritten once as Parquet and the CSVs it came from are
released. On a 4.5 GB feed that costs about six seconds and pays for
itself immediately: counts and filters go from seconds to milliseconds, and the
feed occupies roughly a twentieth of the disk. `--no-parquet` keeps the original
behaviour of reading the CSVs where they sit.

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

pytest with branch coverage, which must stay at or above 80%. This includes the
performance guards in `tests/test_performance_guards.py`, which assert the
structural properties behind past regressions - how often a file is scanned,
what a map feature carries, whether a handler blocks the event loop.

One guard needs a real browser and is excluded from that run, because peak
memory is the one thing no server-side test can see:

```bash
pip install -e ".[dev,perf]" && playwright install chromium
(cd web && yarn build)
pytest -m browser
```

`scripts/benchmark.sh` measures a generated feed: payload sizes, feature
and vertex counts, and the time each phase takes. It reports rather than asserts.

On a pull request, CI runs it twice on the same runner - once on the branch, once
on its merge base - and posts the difference as a comment, so a number is judged
against `main` rather than read in isolation. Exact metrics like payload bytes are
flagged when they move; timings are shown but vary with the runner.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the stack, the layers and why
  they are split the way they are, including which pieces are built to be used
  from outside this repository.

## License

Apache 2.0. See [LICENSE](LICENSE).
