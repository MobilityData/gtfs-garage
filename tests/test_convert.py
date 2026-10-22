"""The per-table conversion API in `gtfs_garage_core.convert`.

These are the properties every reader of the Parquet depends on, checked one
table at a time and without a `GtfsFeed` - the way a caller converting a large
feed under a memory limit uses them. The feed-level tests cover the same SQL
through `GtfsFeed`, which calls these functions.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import duckdb
import pytest

from gtfs_garage_core import __version__
from gtfs_garage_core.convert import (
    MANIFEST,
    MANIFEST_VERSION,
    convert_table,
    manifest_entry,
    register_table,
    write_manifest,
)
from gtfs_garage_core.feed import GtfsFeed

FIXTURE_DIR = Path(__file__).parent / "data" / "mini-gtfs"
FLEX_DIR = Path(__file__).parent / "data" / "flex-gtfs"

# A numeric-looking column and an empty field.
STOPS = "stop_id,stop_name,stop_lat,stop_desc\nS1,One,45.5,\nS2,Two,45.6,plain\n"


@pytest.fixture()
def con():
    connection = duckdb.connect()
    yield connection
    connection.close()


def _types(con, relation: str) -> dict[str, str]:
    return {row[0]: row[1] for row in con.execute(f"DESCRIBE SELECT * FROM {relation}").fetchall()}


def test_every_column_is_text_and_an_empty_field_is_null(con, tmp_path: Path):
    source = tmp_path / "stops.txt"
    source.write_text(STOPS, encoding="utf-8")

    assert register_table(con, "stops", source) == ["stop_id", "stop_name", "stop_lat", "stop_desc"]
    target = tmp_path / "stops.parquet"
    convert_table(con, "stops", target)

    stored = f"read_parquet('{target}')"
    assert set(_types(con, stored).values()) == {"VARCHAR"}
    assert con.execute(f"SELECT stop_desc FROM {stored} WHERE stop_id = 'S1'").fetchone()[0] is None


def test_locations_are_flattened_to_text(con, tmp_path: Path):
    assert register_table(con, "locations", FLEX_DIR / "locations.geojson") == [
        "id",
        "stop_name",
        "stop_desc",
        "geometry_type",
        "geometry",
    ]
    target = tmp_path / "locations.parquet"
    convert_table(con, "locations", target)

    assert set(_types(con, f"read_parquet('{target}')").values()) == {"VARCHAR"}


@pytest.mark.parametrize("content", ["{not json", '{"type": "FeatureCollection", "features": 3}'])
def test_an_unreadable_zones_file_registers_nothing(con, tmp_path: Path, content: str):
    source = tmp_path / "locations.geojson"
    source.write_text(content, encoding="utf-8")

    assert register_table(con, "t", source) is None
    assert con.execute("SELECT count(*) FROM duckdb_views() WHERE view_name = 't'").fetchone()[0] == 0


def test_a_table_that_will_not_convert_raises(con, tmp_path: Path):
    with pytest.raises(duckdb.Error):
        convert_table(con, "missing", tmp_path / "missing.parquet")


def test_a_manifest_entry_names_its_file():
    entry = manifest_entry("stops", rows=2, columns=4, bytes=10, compressed_bytes=None, parquet_bytes=7)
    assert entry == {
        "name": "stops",
        "file": "stops.parquet",
        "rows": 2,
        "columns": 4,
        "bytes": 10,
        "compressed_bytes": None,
        "parquet_bytes": 7,
    }


def test_the_manifest_describes_the_dataset(tmp_path: Path):
    tables = [
        {"name": "a", "file": "a.parquet", "bytes": 100, "parquet_bytes": 10},
        {"name": "b", "file": "b.parquet", "bytes": None, "parquet_bytes": 5},
    ]

    path = write_manifest(tmp_path, tables, source_kind="zip", source_bytes=40)

    assert path == tmp_path / MANIFEST
    manifest = json.loads(path.read_text(encoding="utf-8"))
    assert manifest["version"] == MANIFEST_VERSION == 2
    assert manifest["gtfs_garage"] == __version__
    assert manifest["source"] == {"kind": "zip", "bytes": 40}
    assert manifest["totals"] == {"uncompressed_bytes": 100, "stored_bytes": 15}
    assert manifest["tables"] == tables


def test_table_by_table_matches_a_whole_feed(con, tmp_path: Path):
    """The per-table path and `GtfsFeed` write the same rows, so either can feed the viewer."""
    work = tmp_path / "feed"
    shutil.copytree(FIXTURE_DIR, work)
    feed = GtfsFeed(str(work), optimise=False)
    try:
        whole = tmp_path / "whole"
        feed.export_parquet(whole)
    finally:
        feed.close()

    for source in sorted(work.glob("*.txt")):
        table = source.stem
        register_table(con, table, source)
        single = tmp_path / f"{table}.parquet"
        convert_table(con, table, single)
        mine = con.execute(f"SELECT * FROM read_parquet('{single}')").fetchall()
        theirs = con.execute(f"SELECT * FROM read_parquet('{whole / f'{table}.parquet'}')").fetchall()
        assert mine == theirs, table
