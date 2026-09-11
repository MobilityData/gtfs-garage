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


class TestLoadStats:
    def test_records_every_file_it_registered(self, feed: GtfsFeed):
        assert {f.table for f in feed.stats.files} == set(feed.tables)

    def test_records_a_size_and_a_shape_per_file(self, feed: GtfsFeed):
        stops = next(f for f in feed.stats.files if f.table == "stops")
        assert stops.name == "stops.txt"
        assert stops.bytes > 0
        assert stops.columns == len(feed.tables["stops"])
        assert stops.register_ms >= 0

    def test_a_folder_has_no_unzip_phase_and_no_compressed_sizes(self, feed: GtfsFeed):
        assert feed.stats.extract_ms is None
        assert all(f.compressed_bytes is None for f in feed.stats.files)

    def test_source_bytes_is_the_sum_of_the_files(self, feed: GtfsFeed):
        assert feed.stats.source_bytes == sum(f.bytes for f in feed.stats.files)

    def test_counts_are_only_known_once_something_counts(self, feed: GtfsFeed):
        # Views are lazy, so nothing has been read yet.
        assert all(f.row_count is None and f.count_ms is None for f in feed.stats.files)

        feed.stats.record_count("stops", feed.row_count("stops"), 1.5)
        stops = next(f for f in feed.stats.files if f.table == "stops")
        assert (stops.row_count, stops.count_ms) == (3, 1.5)

    def test_recording_a_count_for_an_absent_table_is_ignored(self, feed: GtfsFeed):
        feed.stats.record_count("nope", 1, 1.0)
        assert all(f.row_count is None for f in feed.stats.files)

    def test_total_ms_adds_up_the_phases_it_has(self, feed: GtfsFeed):
        feed.stats.record_count("stops", 3, 2.0)
        feed.stats.record_count("trips", 3, 3.0)
        assert feed.stats.count_ms == 5.0
        assert feed.stats.total_ms == feed.stats.register_ms + 5.0

    def test_a_zip_reports_its_own_size_and_the_unzip_it_did(self, feed_zip: Path):
        loaded = GtfsFeed(str(feed_zip))
        try:
            assert loaded.stats.source_bytes == feed_zip.stat().st_size
            assert loaded.stats.extract_ms is not None
            stops = next(f for f in loaded.stats.files if f.table == "stops")
            # A GTFS file of repeated text always shrinks.
            assert 0 < stops.compressed_bytes < stops.bytes
        finally:
            loaded.close()

    def test_a_nested_zip_still_matches_its_members_to_their_files(self, nested_feed_zip: Path):
        loaded = GtfsFeed(str(nested_feed_zip))
        try:
            assert all(f.compressed_bytes is not None for f in loaded.stats.files)
        finally:
            loaded.close()
