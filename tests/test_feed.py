from pathlib import Path

import pytest

from gtfs_garage.core.feed import GtfsFeed, GtfsLoadError


def test_loads_an_extracted_folder(feed: GtfsFeed):
    assert set(feed.tables) == {
        "agency",
        "calendar",
        "routes",
        "shapes",
        "stop_times",
        "stops",
        "trips",
    }
    assert feed.tables["routes"][0] == "route_id"


def test_loads_a_zip(feed_zip: Path):
    loaded = GtfsFeed(str(feed_zip))
    try:
        assert loaded.row_count("stops") == 3
    finally:
        loaded.close()


def test_loads_a_zip_whose_files_sit_in_a_subfolder(nested_feed_zip: Path):
    loaded = GtfsFeed(str(nested_feed_zip))
    try:
        assert loaded.row_count("routes") == 2
    finally:
        loaded.close()


def test_row_count_matches_the_fixture(feed: GtfsFeed):
    assert feed.row_count("stop_times") == 6
    assert feed.row_count("trips") == 3


def test_every_column_is_read_as_text_so_odd_values_still_open(feed: GtfsFeed):
    value = feed.cursor().execute("SELECT stop_lat FROM stops LIMIT 1").fetchone()[0]
    assert isinstance(value, str)


def test_empty_fields_become_null(feed: GtfsFeed):
    # This is why `= (empty)` has to be a null test in the filter layer.
    missing = feed.cursor().execute("SELECT COUNT(*) FROM stop_times WHERE pickup_type IS NULL").fetchone()[0]
    assert missing == 2


def test_cursors_are_independent(feed: GtfsFeed):
    # A single connection cannot serve concurrent requests, so every caller
    # takes its own cursor; interleaving them must not disturb either result.
    first, second = feed.cursor(), feed.cursor()
    first.execute("SELECT COUNT(*) FROM stops")
    second.execute("SELECT COUNT(*) FROM routes")
    assert first.fetchone()[0] == 3
    assert second.fetchone()[0] == 2


def test_missing_path_is_rejected(tmp_path: Path):
    with pytest.raises(GtfsLoadError):
        GtfsFeed(str(tmp_path / "nope.zip"))


def test_a_file_that_is_not_a_zip_is_rejected(tmp_path: Path):
    impostor = tmp_path / "feed.zip"
    impostor.write_text("this is not a zip")
    with pytest.raises(GtfsLoadError):
        GtfsFeed(str(impostor))


def test_a_folder_without_gtfs_files_is_rejected(tmp_path: Path):
    with pytest.raises(GtfsLoadError):
        GtfsFeed(str(tmp_path))
