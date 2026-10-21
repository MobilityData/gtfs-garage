# GTFS Garage

A local browser for GTFS feeds. Open a feed and get an overview of what is in
it, a calendar that says which days it runs, a page per route - and under all of
that, the files themselves: tables whose IDs are clickable across files, a
filter builder that never asks you to write SQL, and a map of the stops and
route shapes.

Built for feeds that are too large or too cross-referenced to inspect in a
spreadsheet: DuckDB queries the `.txt` files where they sit, so there is no
import step and only the rows on screen are ever materialised.

- **See what the feed is, before knowing its file names.** The Overview says
  who runs it, what they run, how big it is, when it expires and which optional
  parts of GTFS it uses. Every figure is a link into the rows it was counted
  from - nothing is asserted that cannot be checked one click later.
- **Work from a day, when you want one.** Nothing is filtered by date until you
  pick one - the route list shows every route the feed has. Choose a day and a
  chip appears above the content saying which day it is and what kind of day
  that turned out to be; everything below follows it until you clear it.
  **Jump to** offers real dates: today, the next Saturday, the first and last
  day of the feed.
- **Read a timetable.** Stops down, trips across, for one route on the chosen
  day - the artefact an operator recognises, and the one GTFS spreads over four
  files. A trip that does not call somewhere leaves a blank, so the short
  working and the express are visible as holes rather than hidden. Selecting a
  trip draws it on the map above the grid and frames it on that trip; clicking
  a stop centres the map on it and marks it; clicking a time opens the row in
  `stop_times.txt` it came from. A toggle swaps the names for the `stop_id`s
  and `trip_id`s, for when the next thing you do is look one of them up.
- **See when the schedule changes.** Service days draws one band per kind of day
  across the feed's whole range, however long that is - the week "Weekdays" ends
  and "Mon, Tue, Wed, Fri" begins is where one band stops and another starts -
  and lists those dates outright. Not a grid of every date: a feed declaring
  service to 2100 is twenty-eight thousand cells, and nobody reads one to find a
  Tuesday.
- **Narrow the route list by what the routes are.** Mode, agency, how much each
  one runs, and what is worth noticing - no colour, no short name, no trips at
  all. Each option carries how many routes it would leave, counted against
  everything else already chosen, so the row says the feed has eight rail routes
  and fourteen without a colour before anything is clicked. The chosen filters
  are in the link.
- **Open a route.** Its colour and mode, its directions and headsigns, the
  distinct stop sequences its trips follow - each with the share of the route's
  trips that follows it - when it starts and stops, and what it does on each day
  of the week. The map shows that route and its stops alone, because a line
  drawn among every other line in the city is hidden rather than shown.
- **Explore, or Files.** Two halves behind one switch: the views above, and the
  feed exactly as written. A sidebar entry means one thing.
- **Keep the files.** None of the above replaces the file browser: the sidebar
  lists every file the feed has, with its row counts, and the raw view shows the
  characters the feed contains. The derived views are a second way in.
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
  the rows, and the time spent reading the header versus counting the rows. The
  Options menu carries a one-line summary that opens into the full breakdown,
  largest file first.
- **Know where it went.** Every file a run writes lands in one directory whose
  path is printed on start, and `--workdir` says which. The Options menu lists
  what is in it and what that weighs, reopens a feed already there without
  fetching it again, and empties it on request.
- **Pick up where you left off.** The workdir is kept, so a feed loaded once is
  still there next time — already Parquet, so reopening it costs no download, no
  unzip and no conversion. Start with nothing and the load dialog lists what is
  there; `--reopen` opens one without the dialog, and marking a feed **At
  startup** in the Options menu has every later run open it with no flag at all.
- **Understand a validation report.** Load the `report.json` gtfs-validator
  wrote for the feed and **Quality** lists what it found, most severe first.
  **Explain** starts the **Quality assistant**, which walks through one
  finding step by step: it opens the rows the notice names - by the same line
  numbers the validator uses - while the map draws what the notice means,
  such as the distance from a stop to its line, then says why the rule exists
  and what would fix it. The walkthroughs are YAML guides in this repository,
  and a notice without one is explained from its fields. See
  [docs/QUALITY.md](docs/QUALITY.md).
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
            [--no-parquet] [--workdir DIR] [--workdir-keep N] [--reopen [ID]]
            [--no-reopen] [--version] [feed]
```

At load the feed is rewritten once as Parquet and the CSVs it came from are
released. On a 4.5 GB feed that costs about six seconds and pays for
itself immediately: counts and filters go from seconds to milliseconds, and the
feed occupies roughly a twentieth of the disk. `--no-parquet` keeps the original
behaviour of reading the CSVs where they sit.

## The workdir

Everything a run writes — the extracted feed, the Parquet it becomes, anything
uploaded or downloaded — goes in one directory, and the path is printed on
start. By default that is a shared directory under the platform cache, and it is
**kept**: a feed loaded in one run is there for the next one, which is what
makes a second look at it instant. `--workdir DIR` puts it where you say
instead, which is worth doing for feeds you want somewhere you can see.

```bash
gtfs-garage --workdir ~/gtfs-work path/to/feed.zip
```

Kept does not mean unbounded: `--workdir-keep N` (default 3) is how many feeds
survive before the oldest is dropped. `1` drops the previous feed as soon as a
new one loads, and `0` keeps every feed. Only `--export` takes a directory of
its own and removes it afterwards — it writes its answer somewhere else.

So an ordinary second run has something to offer before you have done anything:

```bash
gtfs-garage            # the load dialog lists the feeds already converted
gtfs-garage --reopen   # or skip the dialog and open the most recent
```

`--reopen` starts on a feed the workdir already holds, with no feed argument.
Bare, it takes the most recently loaded; an ID picks one, as the Options menu
lists them.

The same feeds are offered in the browser: open with nothing loaded and the
load dialog lists what is in the workdir above the ways of fetching something
new. That list appears only when the server has a workdir, so a viewer pointed
at a hosted backend never shows it.

The **Options** menu in the header shows the workdir, what it weighs, and the
feeds in it, with a button to reopen one and buttons to delete them. The feed
on screen is never deleted — its Parquet is what every query reads — so emptying
the workdir while browsing leaves exactly that one behind.

Each row there also has an **At startup** button, which is `--reopen ID` stored
in the workdir rather than typed: the marked feed is what the next run opens,
with no feed argument and no flag. Click it again to clear the choice. A feed
named on the command line still wins, as does an explicit `--reopen`, and
`--no-reopen` ignores the mark for one run. If the marked feed has since been
deleted or dropped by `--workdir-keep`, the server starts empty and the load
dialog offers what is left.

Both are also read from `$GTFS_GARAGE_WORKDIR` and `$GTFS_GARAGE_WORKDIR_KEEP`,
and `$GTFS_GARAGE_NO_REOPEN` does what `--no-reopen` does.

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

## Integration checks

```bash
scripts/integrations.sh              # all five
scripts/integrations.sh local static # just those
```

The suites above cover the pieces; this covers the configurations, which is
where the defects have been. It drives a real browser against each way the
viewer can be deployed - the standalone application, an embedded viewer, a host
mounting the REST source, and Parquet on a static host with no server at all -
and asserts what each one promises. Every server it starts gets a workdir of
its own, so a run never touches the shared one under your platform cache.

To look at them yourself rather than have them asserted:

```bash
scripts/run-integrations.sh                 # the test fixture
scripts/run-integrations.sh ~/feeds/stm.zip # a real feed
```

It exports the feed to Parquet, starts the API, the interface and a server that
behaves the way the dataset bucket does, and prints a URL per configuration.
`?mode=static` is the one MobilityData's operations web app runs: the npm viewer
with `ParquetSource` against the public bucket, calling no HTTP API at all — map
included, since that source builds the map's layers from the same Parquet.
Ctrl-C stops everything and removes what the run wrote.

The fifth check is `conformance`. The derived views exist twice - in
`gtfs_garage.core`, served over HTTP, and in `web/src/sources/explore/`,
computed in a browser against Parquet - so it asks both for the same payloads
over the same feed and diffs them. `--against <base-url>` runs the same
comparison against any backend implementing
[the API](docs/GtfsGarageAPI.yaml) and serving the fixture feed.

Needs a browser:

```bash
pip install -e ".[dev,perf]" && playwright install chromium
```

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
- [docs/INTEGRATION.md](docs/INTEGRATION.md) — mounting the viewer in another
  application, and what that application has to serve it.
- [docs/QUALITY.md](docs/QUALITY.md) — the Quality screen and assistant, how
  to write a guide for a validator notice, and how rows are numbered the way
  the validator numbers them.
- [docs/GtfsGarageAPI.yaml](docs/GtfsGarageAPI.yaml) — the HTTP contract, in
  OpenAPI. It is the source of truth: the server's models and the viewer's
  types are both generated from it by `scripts/api-gen.sh`.

## License

Apache 2.0. See [LICENSE](LICENSE).
