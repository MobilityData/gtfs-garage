"""The feed overview: the counts, the modes, the window and the feature list.

The cases worth asserting are the ones where the honest answer is not the
obvious one - a station is not a stop, an unused agency still appears, and an
optional file the feed lacks is reported rather than omitted.
"""

from pathlib import Path

from gtfs_garage.core.feed import GtfsFeed
from gtfs_garage.core.overview import feed_overview


def test_counts_boarding_places_not_stations(explore_feed: GtfsFeed) -> None:
    overview = feed_overview(explore_feed)
    # Six rows in stops.txt, one of which is a parent station.
    assert overview["counts"]["stops"] == 5
    assert overview["counts"]["stations"] == 1


def test_counts_distinct_shapes_rather_than_shape_rows(explore_feed: GtfsFeed) -> None:
    overview = feed_overview(explore_feed)
    assert overview["counts"]["shapes"] == 4
    assert explore_feed.row_count("shapes") > 4


def test_agencies_carry_their_route_counts(explore_feed: GtfsFeed) -> None:
    agencies = {agency["name"]: agency for agency in feed_overview(explore_feed)["agencies"]}
    assert agencies["City Transit"]["routes"] == 3
    assert agencies["Regional Rail"]["routes"] == 1
    assert agencies["City Transit"]["timezone"] == "America/Montreal"


def test_modes_are_spelled_out(explore_feed: GtfsFeed) -> None:
    modes = {mode["label"]: mode["routes"] for mode in feed_overview(explore_feed)["modes"]}
    assert modes == {"Bus": 3, "Rail": 1}


def test_an_extended_route_type_is_reported_by_number_not_guessed(tmp_path: Path) -> None:
    """The 100s and 700s are not in GTFS's own enumeration."""
    directory = tmp_path / "extended"
    directory.mkdir()
    (directory / "stops.txt").write_text("stop_id,stop_name,stop_lat,stop_lon\nS1,One,45.0,-73.0\n")
    (directory / "routes.txt").write_text("route_id,route_type\nR1,700\n")
    feed = GtfsFeed(str(directory), optimise=False)
    try:
        assert feed_overview(feed)["modes"] == [{"route_type": "700", "label": "Type 700", "routes": 1}]
    finally:
        feed.close()


def test_the_published_row_is_read_from_feed_info(explore_feed: GtfsFeed) -> None:
    published = feed_overview(explore_feed)["published"]
    assert published["feed_publisher_name"] == "City Transit Authority"
    assert published["feed_version"] == "2026-spring"


def test_a_feed_without_feed_info_reports_nothing_rather_than_failing(feed: GtfsFeed) -> None:
    assert feed_overview(feed)["published"] == {}


def test_features_report_absence_as_well_as_presence(explore_feed: GtfsFeed) -> None:
    features = {feature["name"]: feature for feature in feed_overview(explore_feed)["features"]}

    assert features["Route shapes"]["present"] is True
    assert features["Route shapes"]["tables"] == ["shapes"]
    # Named so the reader knows it was checked, not skipped.
    assert features["Fares v2"]["present"] is False
    assert features["Fares v2"]["tables"] == []


def test_a_feature_can_be_a_column_rather_than_a_file(explore_feed: GtfsFeed, feed: GtfsFeed) -> None:
    """Headsigns live on trips.txt, which every feed has."""
    rich = {f["name"]: f for f in feed_overview(explore_feed)["features"]}
    plain = {f["name"]: f for f in feed_overview(feed)["features"]}

    assert rich["Headsigns"]["present"] is True
    assert plain["Headsigns"]["present"] is False


def test_the_service_window_spans_both_calendar_files(explore_feed: GtfsFeed) -> None:
    window = feed_overview(explore_feed)["service"]
    assert window["first_date"] == "2026-01-01"
    assert window["last_date"] == "2026-06-30"
    assert isinstance(window["days_remaining"], int)


def test_a_feed_with_no_calendar_reports_why_rather_than_failing(tmp_path: Path) -> None:
    directory = tmp_path / "nocal"
    directory.mkdir()
    (directory / "stops.txt").write_text("stop_id,stop_name,stop_lat,stop_lon\nS1,One,45.0,-73.0\n")
    feed = GtfsFeed(str(directory), optimise=False)
    try:
        window = feed_overview(feed)["service"]
        assert window["first_date"] is None
        assert "calendar" in window["note"]
    finally:
        feed.close()
