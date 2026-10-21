"""Turning a GTFS file into Parquet, one table at a time.

`GtfsFeed` registers a whole feed and converts it in one go, but nothing here
needs a feed: each function takes a DuckDB connection and one table. That is the
shape a caller with little memory wants - `mobility-feed-api` fetches, converts,
uploads and deletes one table before starting the next, so its peak tracks the
largest table rather than the feed - and it is why the SQL lives here rather
than inside `GtfsFeed`, which uses the same functions.

Two properties are load-bearing for every reader, and neither is obvious:

- Every column is text. The queries compare with ILIKE and with `= ''`, so a
  typed column silently breaks filtering rather than failing loudly.
  `ALL_VARCHAR` on the way in is what guarantees it on the way out.
- An empty CSV field becomes NULL, not an empty string (`NULLSTR = ''`).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from gtfs_garage_core import __version__

# Describes an exported dataset, so a reader need not probe for its tables.
MANIFEST = "manifest.json"

# Version 2 added the sizes the load report shows. Version 1 carried only a
# table list, and its `bytes` meant the Parquet size rather than the source's -
# so a reader has to know which it is holding. Bump it when a field changes
# meaning; adding one a reader may ignore does not need it.
MANIFEST_VERSION = 2

# The Parquet a conversion writes, versioned apart from the package: bump it when
# the files change in a way that makes earlier ones wrong for a current reader,
# such as a column's type. A caller that keeps converted datasets around keys
# them on this, so a bump invalidates them all instead of serving files the
# reader no longer matches.
CONVERTER_VERSION = 1

# The one GTFS file that is not a CSV, and the table it becomes.
LOCATIONS_GEOJSON = "locations.geojson"
LOCATIONS_TABLE = "locations"


def sql_path(path: Path) -> str:
    return "'" + str(path).replace("'", "''") + "'"


def register_table(con, table: str, source: Path) -> list[str] | None:
    """Declare a view named `table` over one GTFS file, and return its columns.

    A `.txt` file is read as CSV and `locations.geojson` as a FeatureCollection
    flattened to one row per Feature. Returns None, leaving no view behind, for
    a file DuckDB cannot read, so one optional file cannot fail a whole feed.
    """
    if source.name == LOCATIONS_GEOJSON:
        return _register_locations(con, table, source)
    try:
        con.execute(f"""
            CREATE VIEW "{table}" AS
            SELECT * FROM read_csv(
                {sql_path(source)},
                ALL_VARCHAR = TRUE,
                IGNORE_ERRORS = TRUE,
                NULLSTR = ''
            )
            """)
    except Exception:
        return None
    return [row[0] for row in con.execute(f'DESCRIBE "{table}"').fetchall()]


def _register_locations(con, table: str, source: Path) -> list[str] | None:
    """Register locations.geojson, the one GTFS file that is not a CSV.

    GTFS-Flex describes pickup and drop-off zones as GeoJSON polygons, and
    `stop_times.location_id` references a Feature's id. Flattening the
    FeatureCollection to one row per Feature is what lets the rest of the
    application treat it like any other file: it browses, filters and links
    with no special case anywhere downstream.

    Every column is cast to VARCHAR to match the `read_csv(ALL_VARCHAR)`
    contract the rest of the code is written against - `filters.py` compares
    with ILIKE and `= ''`, which need text.
    """
    try:
        # `features` is read as opaque JSON rather than letting DuckDB infer
        # its shape, so a feed mixing Polygon and MultiPolygon cannot change
        # the columns this produces.
        con.execute(f"""
            CREATE VIEW "{table}" AS
            SELECT
                CAST(json_extract_string(feature, '$.id') AS VARCHAR) AS id,
                CAST(json_extract_string(feature, '$.properties.stop_name') AS VARCHAR)
                    AS stop_name,
                CAST(json_extract_string(feature, '$.properties.stop_desc') AS VARCHAR)
                    AS stop_desc,
                CAST(json_extract_string(feature, '$.geometry.type') AS VARCHAR)
                    AS geometry_type,
                CAST(json_extract(feature, '$.geometry') AS VARCHAR) AS geometry
            FROM (
                SELECT unnest(features) AS feature
                FROM read_json(
                    {sql_path(source)},
                    columns = {{type: 'VARCHAR', features: 'JSON[]'}}
                )
            )
            """)
        columns = [row[0] for row in con.execute(f'DESCRIBE "{table}"').fetchall()]
        # A view is lazy, so creating one over malformed JSON succeeds and the
        # parse error surfaces later - during the Parquet conversion, or under a
        # reader's query. Reading a row here forces the parse while it can
        # still be handled.
        con.execute(f'SELECT * FROM "{table}" LIMIT 1').fetchall()
    except Exception:
        # Malformed JSON, or a document that is not a FeatureCollection. The
        # rest of the feed still opens; the zones are simply not there.
        con.execute(f'DROP VIEW IF EXISTS "{table}"')
        return None
    return columns


def convert_table(con, table: str, destination: Path) -> None:
    """Write the view `table` as Parquet at `destination`.

    Selecting through the view preserves ALL_VARCHAR, so every column stays
    text. Raises whatever DuckDB raises when the table will not convert, so the
    caller decides what a failure costs.
    """
    con.execute(f"""COPY (SELECT * FROM "{table}") TO {sql_path(destination)} (FORMAT PARQUET, COMPRESSION ZSTD)""")


def manifest_entry(
    table: str,
    *,
    rows: int,
    columns: int,
    bytes: int | None,
    compressed_bytes: int | None,
    parquet_bytes: int | None,
) -> dict:
    """One table's record in the manifest.

    `bytes` and `compressed_bytes` are what the file weighed before conversion
    and inside the archive it arrived in. Neither can be recovered later: the
    CSVs are deleted once converted, and a zip member's compressed size only
    exists in the archive's directory.
    """
    return {
        "name": table,
        "file": f"{table}.parquet",
        "rows": rows,
        "columns": columns,
        "bytes": bytes,
        "compressed_bytes": compressed_bytes,
        "parquet_bytes": parquet_bytes,
    }


def write_manifest(destination: Path, tables: list[dict], *, source_kind: str, source_bytes: int) -> Path:
    """Describe a converted dataset beside it, for a reader that will never see the source.

    `tables` are `manifest_entry` records. `source_kind` is "zip", "folder" or
    "parquet", and `source_bytes` what the source weighed.
    """
    sized = [t for t in tables if t.get("bytes") is not None]
    manifest = {
        "version": MANIFEST_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        # Named after the application for the readers that already look for
        # it; the two packages are released together, so the version is the same.
        "gtfs_garage": __version__,
        "source": {"kind": source_kind, "bytes": source_bytes},
        "totals": {
            "uncompressed_bytes": sum(t["bytes"] for t in sized),
            "stored_bytes": sum(t["parquet_bytes"] or 0 for t in tables),
        },
        "tables": tables,
    }
    path = destination / MANIFEST
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return path
