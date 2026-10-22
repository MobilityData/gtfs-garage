"""Line numbers: every row maps back to the line gtfs-validator would name.

The expected numbers here are the validator's own. A fixture with a quoted
value spanning lines 2 to 4 was run through gtfs-validator 8.0.1, which
reported that record as `csvRowNumber` 4 and the records after it by their own
lines - so a record is numbered by the line it ends on, header as line 1.
"""

from __future__ import annotations

import shutil
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

from gtfs_garage.core.feed import GtfsFeed
from gtfs_garage_core.lines import kept_record_lines, physical_lines
from gtfs_garage.core.queries import query_table, table_summaries

AGENCY = "agency_id,agency_name,agency_url,agency_timezone\nA1,Test,https://example.org,UTC\n"

# Line by line:  1 header | 2-4 one record (multi-line value) | 5 too few
# fields, dropped | 6 too many, dropped | 7 blank | 8 | 9-10 multi-line | 11
BROKEN_STOPS = (
    "stop_id,stop_name,stop_desc\n"
    'A,Stop A,"first\nsecond\nthird"\n'
    "B,Stop B\n"
    "C,Stop C,x,extra\n"
    "\n"
    "D,Stop D,plain\n"
    'E,Stop E,"x\ny"\n'
    "F,Stop F,plain\n"
)
BROKEN_LINES = {"A": 4, "D": 8, "E": 10, "F": 11}

PLAIN_STOPS = "stop_id,stop_name\n" + "".join(f"S{i},Stop {i}\n" for i in range(50))


@contextmanager
def opened(path: Path, **options) -> Iterator[GtfsFeed]:
    feed = GtfsFeed(str(path), **options)
    try:
        yield feed
    finally:
        feed.close()


def write(directory: Path, stops: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "agency.txt").write_text(AGENCY, encoding="utf-8")
    (directory / "stops.txt").write_text(stops, encoding="utf-8")
    return directory


def lines_by_id(feed: GtfsFeed) -> dict[str, int]:
    page = query_table(feed, "stops", [], 1, 500, lines=True)
    return {row[0]: line for row, line in zip(page["rows"], page["lines"])}


def stops_summary(feed: GtfsFeed) -> dict:
    return next(t for t in table_summaries(feed) if t["name"] == "stops")


class TestCountingTheFile:
    def test_a_trailing_newline_is_not_a_line(self, tmp_path: Path):
        path = tmp_path / "f.txt"
        path.write_text("a\n1\n2\n\n\n", encoding="utf-8")
        assert physical_lines(path) == 3

    def test_a_file_without_a_final_newline_counts_its_last_line(self, tmp_path: Path):
        path = tmp_path / "f.txt"
        path.write_text("a\n1\n2", encoding="utf-8")
        assert physical_lines(path) == 3

    def test_crlf_counts_the_same(self, tmp_path: Path):
        path = tmp_path / "f.txt"
        path.write_bytes(b"a\r\n1\r\n2\r\n")
        assert physical_lines(path) == 3

    def test_the_python_pass_keeps_what_duckdb_keeps(self, tmp_path: Path):
        path = tmp_path / "stops.txt"
        path.write_text(BROKEN_STOPS, encoding="utf-8")
        assert kept_record_lines(path) == sorted(BROKEN_LINES.values())


class TestConvertedFeeds:
    def test_a_plain_file_is_numbered_by_position_and_says_it_is_exact(self, tmp_path: Path):
        with opened(write(tmp_path / "feed", PLAIN_STOPS)) as feed:
            assert feed.lines["stops"].storage == "position"
            assert stops_summary(feed)["lines"] == "exact"
            assert lines_by_id(feed)["S0"] == 2
            assert lines_by_id(feed)["S49"] == 51

    def test_a_broken_file_stores_the_validators_numbers(self, tmp_path: Path):
        with opened(write(tmp_path / "feed", BROKEN_STOPS)) as feed:
            assert feed.lines["stops"].storage == "column"
            assert stops_summary(feed)["lines"] == "exact"
            assert lines_by_id(feed) == BROKEN_LINES

    def test_the_stored_line_is_not_a_column_of_the_table(self, tmp_path: Path):
        with opened(write(tmp_path / "feed", BROKEN_STOPS)) as feed:
            assert "_line" not in feed.tables["stops"]
            page = query_table(feed, "stops", [], 1, 10)
            assert "_line" not in page["columns"]
            assert page["lines"] is None

    def test_a_multi_line_value_is_read_whole(self, tmp_path: Path):
        # Before quoting was explicit, a newline past the sniffer's sample was
        # read with no quote character and the continuation silently dropped.
        padding = "".join(f"P{i},Stop {i},plain\n" for i in range(2000))
        stops = "stop_id,stop_name,stop_desc\n" + padding + 'Z,Stop Z,"one\ntwo"\n'
        with opened(write(tmp_path / "feed", stops)) as feed:
            page = query_table(feed, "stops", [{"column": "stop_id", "op": "eq", "value": "Z"}], 1, 10, lines=True)
            assert page["rows"][0][2] == "one\ntwo"
            assert page["lines"] == [2003]


class TestFilteringByLine:
    @pytest.fixture()
    def feed(self, tmp_path: Path):
        with opened(write(tmp_path / "feed", BROKEN_STOPS)) as feed:
            yield feed

    def test_selects_the_row_the_validator_named(self, feed: GtfsFeed):
        page = query_table(feed, "stops", [{"column": "_line", "op": "eq", "value": "10"}], 1, 10)
        assert [row[0] for row in page["rows"]] == ["E"]

    def test_selects_several_lines_in_file_order(self, feed: GtfsFeed):
        page = query_table(feed, "stops", [{"column": "_line", "op": "in", "value": "11, 4"}], 1, 10, lines=True)
        assert [row[0] for row in page["rows"]] == ["A", "F"]
        assert page["lines"] == [4, 11]

    def test_a_dropped_row_selects_nothing(self, feed: GtfsFeed):
        page = query_table(feed, "stops", [{"column": "_line", "op": "eq", "value": "5"}], 1, 10)
        assert page["total"] == 0

    def test_a_value_that_is_not_a_number_selects_nothing(self, feed: GtfsFeed):
        page = query_table(feed, "stops", [{"column": "_line", "op": "eq", "value": "4 OR 1=1"}], 1, 10)
        assert page["total"] == 0

    def test_text_operators_do_not_apply_to_a_line(self, feed: GtfsFeed):
        page = query_table(feed, "stops", [{"column": "_line", "op": "contains", "value": "1"}], 1, 10)
        assert page["total"] == 0


class TestKeepingTheNumbers:
    def test_an_export_carries_stored_lines_and_reopens_exact(self, tmp_path: Path):
        with opened(write(tmp_path / "feed", BROKEN_STOPS)) as feed:
            feed.export_parquet(tmp_path / "export")
        with opened(tmp_path / "export") as reopened:
            assert reopened.lines["stops"].storage == "column"
            assert stops_summary(reopened)["lines"] == "exact"
            assert lines_by_id(reopened) == BROKEN_LINES
            assert "_line" not in reopened.tables["stops"]

    def test_a_dataset_without_a_verdict_is_approximate(self, tmp_path: Path):
        with opened(write(tmp_path / "feed", PLAIN_STOPS)) as feed:
            feed.export_parquet(tmp_path / "export")
        (tmp_path / "export" / "manifest.json").unlink()
        with opened(tmp_path / "export") as reopened:
            assert stops_summary(reopened)["lines"] == "approximate"
            assert lines_by_id(reopened)["S0"] == 2

    def test_reading_csvs_in_place_numbers_by_position_but_does_not_vouch_for_it(self, tmp_path: Path):
        with opened(write(tmp_path / "feed", PLAIN_STOPS), optimise=False) as feed:
            assert stops_summary(feed)["lines"] == "approximate"
            assert lines_by_id(feed)["S7"] == 9

    def test_geojson_locations_have_no_lines(self, demand_feed_dir: Path, tmp_path: Path):
        shutil.copytree(demand_feed_dir, tmp_path / "feed")
        with opened(tmp_path / "feed") as feed:
            summary = next(t for t in table_summaries(feed) if t["name"] == "locations")
            assert summary["lines"] is None
            assert query_table(feed, "locations", [], 1, 10, lines=True)["lines"] is None


# ---------------------------------------------------------------------------
# Against the validator itself.
#
# src/gtfs_garage/data/demos/ holds feeds built to trigger nearly every notice, with the
# report gtfs-validator 8.0.1 wrote for each. Every sample that names a file
# and a csvRowNumber is a line number the validator vouches for, so each one
# must select exactly one row here - except where the validator is reporting
# that the row could not be read, in which case there is no row to select.
# ---------------------------------------------------------------------------

QUALITY = Path(__file__).parent.parent / "src" / "gtfs_garage" / "data" / "demos"

# Notices about a row the loader cannot keep: its values do not line up with
# the header, or it is blank.
UNREADABLE_ROWS = {"invalid_row_length", "empty_row"}


def located_samples(feed: str):
    import json

    report = json.loads((QUALITY / f"{feed}.report.json").read_text(encoding="utf-8"))
    for notice in report["notices"]:
        for sample in notice["sampleNotices"]:
            filename, line = sample.get("filename"), sample.get("csvRowNumber")
            if isinstance(filename, str) and filename.endswith(".txt") and isinstance(line, int):
                yield notice["code"], filename[: -len(".txt")], line


@pytest.mark.parametrize("feed", ["main", "no-calendar", "parse-errors"])
def test_every_row_the_validator_names_is_the_row_selected(feed: str, tmp_path: Path):
    shutil.copytree(QUALITY / feed, tmp_path / feed)
    checked = 0
    with opened(tmp_path / feed) as loaded:
        for code, table, line in located_samples(feed):
            if table not in loaded.tables:
                continue
            page = query_table(loaded, table, [{"column": "_line", "op": "eq", "value": str(line)}], 1, 5, lines=True)
            expected = 0 if code in UNREADABLE_ROWS else 1
            assert page["total"] == expected, f"{code}: {table}.txt line {line} selected {page['total']} rows"
            checked += 1
    assert checked > 0
