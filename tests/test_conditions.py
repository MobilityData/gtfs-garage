"""Conditions answered against the loaded feed rather than quoted at the reader.

The interesting case is the negative one. Both fixtures have exactly one agency,
so `more_than_one_agency` returning False is what proves the check ran at all -
a check that never ran and a check that answered "no" both leave the field
optional, and only the evidence tells them apart.
"""

import shutil
from pathlib import Path

from gtfs_garage.core.conditions import CHECK_KINDS, evaluate
from gtfs_garage.core.feed import GtfsFeed


def _feed_with_agencies(tmp_path: Path, fixture: Path, extra: int) -> GtfsFeed:
    """A copy of the fixture with `extra` further agencies appended."""
    directory = tmp_path / f"feed-{extra}"
    shutil.copytree(fixture, directory)
    rows = "".join(f"A{n + 2},Other {n + 2},https://example.org,America/Montreal\n" for n in range(extra))
    with (directory / "agency.txt").open("a", encoding="utf-8") as handle:
        handle.write(rows)
    return GtfsFeed(str(directory))


# What the three agency_id fields declare, verbatim from the schema document.
MORE_THAN_ONE_AGENCY = {"kind": "row_count", "file": "agency", "minimum": 2}


def test_one_agency_does_not_meet_the_condition(feed: GtfsFeed):
    assert evaluate(feed, MORE_THAN_ONE_AGENCY) == (False, "agency.txt has 1 row")


def test_two_agencies_meet_it(tmp_path: Path, feed_dir: Path):
    loaded = _feed_with_agencies(tmp_path, feed_dir, extra=1)
    try:
        assert evaluate(loaded, MORE_THAN_ONE_AGENCY) == (True, "agency.txt has 2 rows")
    finally:
        loaded.close()


def test_the_evidence_counts_rather_than_asserting(tmp_path: Path, feed_dir: Path):
    """What makes the answer checkable: it says what it counted."""
    loaded = _feed_with_agencies(tmp_path, feed_dir, extra=4)
    try:
        assert evaluate(loaded, MORE_THAN_ONE_AGENCY) == (True, "agency.txt has 5 rows")
    finally:
        loaded.close()


def test_the_check_is_carried_out_from_what_it_declares(feed: GtfsFeed):
    """The point of a declared check rather than a name: the arguments decide
    what happens, so a reader of the document can predict the answer without
    reading this module. The fixture has 3 stops, so the same kind answers a
    file it was never written for."""
    assert evaluate(feed, {"kind": "row_count", "file": "stops", "minimum": 3}) == (
        True,
        "stops.txt has 3 rows",
    )
    assert evaluate(feed, {"kind": "row_count", "file": "stops", "minimum": 4}) == (
        False,
        "stops.txt has 3 rows",
    )


def test_a_feed_without_the_file_it_reads_is_unanswerable(tmp_path: Path, feed_dir: Path):
    """Not an error. GTFS files are largely optional and a feed can be partial,
    so the caller falls back to stating the condition in words."""
    directory = tmp_path / "no-agency"
    shutil.copytree(feed_dir, directory)
    (directory / "agency.txt").unlink()

    loaded = GtfsFeed(str(directory))
    try:
        assert "agency" not in loaded.tables
        assert evaluate(loaded, MORE_THAN_ONE_AGENCY) is None
    finally:
        loaded.close()


def test_a_kind_this_build_does_not_know_is_ignored_rather_than_raised(feed: GtfsFeed):
    """gtfs-schema.json ships in the wheel and is consumed by other projects, so
    it can be newer than the Python beside it. A kind this build cannot carry
    out must degrade to the condition in words, not break the table listing."""
    assert evaluate(feed, {"kind": "from_a_later_release", "file": "agency"}) is None


def test_a_known_kind_with_arguments_it_does_not_recognise_is_ignored(feed: GtfsFeed):
    """Same reasoning one level down: the kind survived into a later release but
    its arguments moved on. The generator rejects this on the way in, so the
    only way to see it is a document from elsewhere."""
    assert evaluate(feed, {"kind": "row_count"}) is None
    assert evaluate(feed, {"kind": "row_count", "file": "agency"}) is None


def test_nothing_is_evaluated_without_a_check(feed: GtfsFeed):
    assert evaluate(feed, None) is None
    assert evaluate(feed, {}) is None


def test_every_implemented_kind_answers_or_declines(feed: GtfsFeed):
    """No kind may raise, whatever feed happens to be open and whatever it is
    pointed at - `table_summaries` runs whatever the schema declares.

    Declining is not the only right answer: `row_count` cannot count a file that
    is not there, while `file_absent` exists precisely to say that it is not.
    """
    for kind in CHECK_KINDS:
        for check in ({"kind": kind, "file": "not_in_this_feed", "minimum": 1}, {"kind": kind}):
            result = evaluate(feed, check)
            assert result is None or (isinstance(result[0], bool) and result[1])


def test_a_file_the_feed_has_is_present(feed: GtfsFeed):
    assert evaluate(feed, {"kind": "file_present", "file": "calendar"}) == (True, "calendar is present")
    assert evaluate(feed, {"kind": "file_absent", "file": "calendar"}) == (False, "calendar is present")


def test_a_file_the_feed_lacks_is_absent(feed: GtfsFeed):
    assert evaluate(feed, {"kind": "file_present", "file": "translations"}) == (False, "translations is absent")
    assert evaluate(feed, {"kind": "file_absent", "file": "translations"}) == (True, "translations is absent")


def test_the_two_kinds_are_opposites_on_every_file(feed: GtfsFeed):
    """Written as separate kinds rather than one with a polarity flag, so this
    is the property that keeps them honest."""
    for table in ["agency", "calendar", "translations", "levels", "not_a_gtfs_file"]:
        present = evaluate(feed, {"kind": "file_present", "file": table})
        absent = evaluate(feed, {"kind": "file_absent", "file": table})
        assert present[0] is not absent[0]
        # The evidence states the feed's state, so it reads the same either way.
        assert present[1] == absent[1]


def test_the_evidence_reports_the_state_not_the_verdict(feed: GtfsFeed):
    """`file_absent` holding is good news for calendar.txt and bad news for
    nothing; the sentence should say what was looked at, not what it implies."""
    holds, evidence = evaluate(feed, {"kind": "file_absent", "file": "calendar_dates"})
    assert holds is True
    assert evidence == "calendar_dates is absent"


def test_a_column_the_file_carries_is_present(feed: GtfsFeed):
    check = {"kind": "column_present", "file": "routes", "column": "route_id"}
    assert evaluate(feed, check) == (True, "routes.route_id is present")


def test_a_column_the_file_lacks_is_absent(feed: GtfsFeed):
    """The real case: networks.txt is forbidden when routes.txt has network_id,
    and the fixture's routes.txt does not."""
    check = {"kind": "column_present", "file": "routes", "column": "network_id"}
    assert evaluate(feed, check) == (False, "routes.network_id is absent")


def test_a_column_in_a_file_the_feed_does_not_have_is_unanswerable(feed: GtfsFeed):
    assert evaluate(feed, {"kind": "column_present", "file": "pathways", "column": "pathway_mode"}) is None


def test_rows_match_counts_what_it_found(feed: GtfsFeed):
    """The evidence names the count, so an answer of "no" can be told apart
    from a file that was never read."""
    check = {"kind": "rows_match", "file": "stops", "column": "location_type", "equals": "1"}
    assert evaluate(feed, check) == (False, "stops has 0 rows with location_type=1")


def test_rows_match_holds_when_a_row_has_the_value(tmp_path: Path, feed_dir: Path):
    directory = tmp_path / "with-station"
    shutil.copytree(feed_dir, directory)
    stops = directory / "stops.txt"
    # Every column, or the loader drops the short row and the test passes for
    # the wrong reason.
    stops.write_text(stops.read_text(encoding="utf-8") + "S9,Central Station,45.5,-73.5,1,,0\n", encoding="utf-8")

    loaded = GtfsFeed(str(directory))
    try:
        check = {"kind": "rows_match", "file": "stops", "column": "location_type", "equals": "1"}
        assert evaluate(loaded, check) == (True, "stops has 1 row with location_type=1")
    finally:
        loaded.close()


def test_rows_match_is_unanswerable_without_the_column(feed: GtfsFeed):
    """levels.txt asks whether any pathway is an elevator. A feed with no
    pathways.txt cannot say, and must not be made to guess."""
    check = {"kind": "rows_match", "file": "pathways", "column": "pathway_mode", "equals": "5"}
    assert evaluate(feed, check) is None
    assert evaluate(feed, {"kind": "rows_match", "file": "stops", "column": "not_a_column", "equals": "5"}) is None
