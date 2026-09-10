# Sharing this code with other MobilityData projects

Three pieces here are worth reusing elsewhere. They are listed in order of how
ready they are.

## 1. The GTFS relationship map

`src/gtfs_garage/data/gtfs-schema.json` — foreign keys, each table's primary id
column, and the columns GTFS defines as enumerations.

This is the piece most likely to be duplicated by accident. Any viewer that makes
IDs clickable needs exactly this table, and a second hand-maintained copy will
drift from the first.

- **From Python**: `from gtfs_garage.core.schema import FOREIGN_KEYS, related_tables`.
  It is read through `importlib.resources`, so it works from an installed wheel.
- **From TypeScript**: import the same file. `resolveJsonModule` is enabled, and
  the frontend build reads it from the package directory rather than keeping a copy.

Consuming it is a `pip install gtfs-garage` away today. If a JavaScript project
needs it without the Python package, publish it as its own small npm package
rather than copying the file.

## 2. The query layer

`gtfs_garage.core` — feed loading, filter-to-SQL translation, table summaries,
pagination, distinct values, and GeoJSON generation.

It imports no web framework (enforced by `tests/test_layering.py`), so
`mobility-feed-api` could use it server-side:

```python
from gtfs_garage.core import GtfsFeed, query_table, table_summaries

feed = GtfsFeed("/path/to/feed.zip")
summaries = table_summaries(feed)
page = query_table(feed, "stop_times", [{"column": "trip_id", "op": "eq", "value": "T1"}])
```

What you get for free by reusing it rather than rewriting: the null-versus-empty
filter semantics, the link resolution against files a feed actually has, and the
per-request cursor rule that a shared DuckDB connection otherwise gets wrong.

## 3. The viewer UI

Not yet packaged for reuse — this is the design, and what remains.

The UI depends on one interface, `GtfsSource` in `web/src/sources/types.ts`:

```ts
interface GtfsSource {
  tables(): Promise<TablesResponse>;
  query(table, filters, page, pageSize): Promise<PageResponse>;
  distinct(table, column, limit?): Promise<ValueCount[]>;
  geojson(kind, ids?): Promise<FeatureCollection>;
}
```

Those types mirror `src/gtfs_garage/server/models.py`, which FastAPI publishes as
OpenAPI — so the contract has a machine-readable definition, and the TypeScript
types can be generated from it rather than kept in step by hand.

`RestSource` implements it against the local Python server. A second
implementation is the interesting one:

**`DuckDbWasmSource`** would run the same SQL in the browser via DuckDB-WASM
against Parquet files fetched with HTTP range requests — the output of the
converter prototyped in
[mobility-feed-api#1728](https://github.com/MobilityData/mobility-feed-api/pull/1728).
The UI would not change; only the adapter does. Note DuckDB-WASM is bound by the
tab's memory, so that path suits medium feeds, and large-feed inspection stays
with the local tool.

To embed the UI in `mobilitydatabase-web`, package it as a **custom element**
rather than a React component. `mobilitydatabase-web` (Next 16 / React 19 /
MUI 7) and `mobilitydatabase-operations-web` (Next 15 / React 18 / MUI 5) are not
on matching majors, and a custom element removes the need for them ever to agree.
React 19 supports custom elements properly, so mounting is unremarkable. Use the
light DOM with CSS custom properties for theming — a shadow root would isolate the
component from the host's styles and make it look foreign on the site.

There is no npm publishing infrastructure in any of these repositories today, so
the first integration should be a git dependency, moving to a published package
once the interface has stopped moving.

## What is deliberately not shared

**The map's dependency on CARTO basemap tiles and the MapLibre CDN script.**
Both are fine for a developer tool and would need revisiting before anything ships
to the public site, which already has its own map stack and its own PMTiles
pipeline.
