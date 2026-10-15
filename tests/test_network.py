"""The route list and the route card.

The interesting cases are the ones where GTFS's own structure hides something:
a route sorted as a string puts 10 before 2, a time past midnight is not a
small number, and a stop sequence followed by one trip is invisible until the
sequences are grouped.
"""

from pathlib import Path

import pytest

from gtfs_garage.core.feed import GtfsFeed
from gtfs_garage.core.network import UnknownRouteError, route_detail, route_list


def test_routes_sort_numerically_not_as_strings(explore_feed: GtfsFeed) -> None:
    ids = [route["route_id"] for route in route_list(explore_feed)]
    assert ids.index("2") < ids.index("10") < ids.index("101")


def test_route_rows_carry_their_mode_and_operator(explore_feed: GtfsFeed) -> None:
    routes = {route["route_id"]: route for route in route_list(explore_feed)}
    assert routes["RL"]["mode"] == "Rail"
    assert routes["RL"]["agency_name"] == "Regional Rail"
    assert routes["10"]["trips"] == 71
    assert routes["10"]["services"] == 2


def test_directions_carry_headsigns_and_shapes(explore_feed: GtfsFeed) -> None:
    detail = route_detail(explore_feed, "10")
    directions = {direction["direction_id"]: direction for direction in detail["directions"]}

    assert directions["0"]["headsigns"] == ["Riverside"]
    assert directions["0"]["shape_ids"] == ["SH10"]
    assert directions["1"]["trips"] == 30


def test_a_route_with_no_shapes_reports_an_empty_list_not_a_failure(explore_feed: GtfsFeed) -> None:
    detail = route_detail(explore_feed, "101")
    assert detail["directions"][0]["shape_ids"] == []


def test_stop_patterns_surface_the_short_working(explore_feed: GtfsFeed) -> None:
    """Route 2 runs twelve full trips and one that stops short. That one trip
    is the thing an operator is looking for and the files do not show."""
    patterns = route_detail(explore_feed, "2")["patterns"]

    assert [pattern["trips"] for pattern in patterns] == [12, 1]
    assert [len(pattern["stops"]) for pattern in patterns] == [3, 2]
    assert patterns[1]["headsign"] == "Market Square"
    assert patterns[0]["stops"][0]["stop_name"] == "Central Station Platform A"


def test_times_past_midnight_are_kept_as_the_feed_states_them(explore_feed: GtfsFeed) -> None:
    """A trip leaving at 25:00 belongs to the service day before, and wrapping
    it to 01:00 would move it a day."""
    timetable = route_detail(explore_feed, "101")["timetable"]

    assert timetable["first_departure"] == "23:00:00"
    assert timetable["last_arrival"] == "25:12:00"
    assert [hour["hour"] for hour in timetable["hours"]] == [23, 24, 25]


def test_the_hour_histogram_counts_each_trip_once(explore_feed: GtfsFeed) -> None:
    detail = route_detail(explore_feed, "10")
    assert sum(hour["trips"] for hour in detail["timetable"]["hours"]) == detail["trips"]


def test_the_weekday_profile_is_narrowed_to_the_route(explore_feed: GtfsFeed) -> None:
    sunday_only = {day["name"]: day["typical_trips"] for day in route_detail(explore_feed, "RL")["weekdays"]}
    assert sunday_only["Sunday"] == 3
    assert sunday_only["Monday"] == 0


def test_service_patterns_name_the_days_a_route_runs(explore_feed: GtfsFeed) -> None:
    """The Sunday-only regional line, plus the Friday a Sunday service was
    added to - which is exactly the kind of day nobody finds by reading
    calendar_dates.txt against a route."""
    names = [pattern["name"] for pattern in route_detail(explore_feed, "RL")["service_patterns"]]
    assert names == ["Sundays", "3 Apr 2026"]


def test_a_route_reports_its_own_first_and_last_day(explore_feed: GtfsFeed) -> None:
    detail = route_detail(explore_feed, "RL")
    assert detail["first_date"] == "2026-01-04"
    # Twenty-six Sundays and the Friday its service was added to.
    assert detail["days_running"] == 27


def test_an_unknown_route_is_an_error_not_an_empty_card(explore_feed: GtfsFeed) -> None:
    with pytest.raises(UnknownRouteError):
        route_detail(explore_feed, "nope")


def test_a_feed_with_no_routes_lists_nothing(tmp_path: Path) -> None:
    directory = tmp_path / "noroutes"
    directory.mkdir()
    (directory / "stops.txt").write_text("stop_id,stop_name,stop_lat,stop_lon\nS1,One,45.0,-73.0\n")
    feed = GtfsFeed(str(directory), optimise=False)
    try:
        assert route_list(feed) == []
    finally:
        feed.close()


def test_a_route_without_direction_or_times_still_opens(tmp_path: Path) -> None:
    """Both columns are optional, and a card that needs them is a card that
    fails on a third of real feeds."""
    directory = tmp_path / "sparse"
    directory.mkdir()
    (directory / "stops.txt").write_text("stop_id,stop_name,stop_lat,stop_lon\nS1,One,45.0,-73.0\n")
    (directory / "routes.txt").write_text("route_id,route_type\nR1,3\n")
    (directory / "trips.txt").write_text("route_id,service_id,trip_id\nR1,S,T1\n")
    (directory / "stop_times.txt").write_text("trip_id,stop_id,stop_sequence\nT1,S1,1\n")

    feed = GtfsFeed(str(directory), optimise=False)
    try:
        detail = route_detail(feed, "R1")
        assert detail["directions"] == [{"direction_id": None, "trips": 1, "headsigns": [], "shape_ids": []}]
        assert detail["timetable"]["hours"] == []
        assert detail["patterns"][0]["stops"][0]["stop_id"] == "S1"
    finally:
        feed.close()


class TestOneDay:
    """The route list narrowed to a date - what turns a day on the calendar
    into something to look at, on the map or as a list."""

    def test_lists_only_the_routes_running_that_day(self, explore_feed: GtfsFeed) -> None:
        from datetime import date

        assert [r["route_id"] for r in route_list(explore_feed, date(2026, 1, 4))] == ["RL"]
        assert [r["route_id"] for r in route_list(explore_feed, date(2026, 1, 3))] == ["10", "101"]

    def test_a_day_with_no_service_lists_nothing(self, explore_feed: GtfsFeed) -> None:
        from datetime import date

        assert route_list(explore_feed, date(2026, 5, 18)) == []

    def test_a_date_outside_the_feed_lists_nothing(self, explore_feed: GtfsFeed) -> None:
        from datetime import date

        assert route_list(explore_feed, date(2030, 6, 1)) == []

    def test_the_exception_that_adds_a_sunday_service_to_a_friday_is_honoured(self, explore_feed: GtfsFeed) -> None:
        from datetime import date

        # 2026-04-03 removes the weekday service and adds the Sunday one, so
        # the regional line runs on a Friday and the city weekday routes do not.
        assert [r["route_id"] for r in route_list(explore_feed, date(2026, 4, 3))] == ["101", "RL"]


class TestTheDayOnARouteCard:
    """What a route does on the day being looked at, beside what it does across
    the feed. Additive: a caller that names no day sees exactly what it saw."""

    def test_absent_when_no_day_is_named(self, explore_feed: GtfsFeed) -> None:
        assert route_detail(explore_feed, "2")["day"] is None

    def test_reports_the_days_trips(self, explore_feed: GtfsFeed) -> None:
        from datetime import date

        assert route_detail(explore_feed, "2", date(2026, 1, 1))["day"] == {
            "service_date": "2026-01-01",
            "trips": 13,
        }

    def test_zero_rather_than_absent_on_a_day_it_does_not_run(self, explore_feed: GtfsFeed) -> None:
        """Which is an answer, not a gap: the reader asked whether it runs."""
        from datetime import date

        assert route_detail(explore_feed, "2", date(2026, 1, 4))["day"]["trips"] == 0

    def test_a_day_outside_the_feed_has_nothing_to_report(self, explore_feed: GtfsFeed) -> None:
        from datetime import date

        assert route_detail(explore_feed, "2", date(2030, 1, 1))["day"] is None


class TestTimetable:
    """The stops-by-trips grid for one route on one day.

    The cases that matter are the ones the grid exists to show: the trip that
    stops short, the service that only runs because of an exception, and times
    that run past midnight.
    """

    def test_lists_the_days_trips_as_columns(self, explore_feed: GtfsFeed) -> None:
        from datetime import date

        from gtfs_garage.core.network import route_timetable

        grid = route_timetable(explore_feed, "2", date(2026, 1, 1))
        assert [stop["stop_name"] for stop in grid["stops"]] == [
            "Central Station Platform A",
            "Market Square",
            "Hilltop",
        ]
        assert len(grid["trips"]) == 13
        assert grid["truncated"] is False

    def test_columns_are_ordered_by_departure(self, explore_feed: GtfsFeed) -> None:
        from datetime import date

        from gtfs_garage.core.network import route_timetable

        grid = route_timetable(explore_feed, "2", date(2026, 1, 1))
        firsts = [trip["calls"][0]["departure"] for trip in grid["trips"]]
        assert firsts == sorted(firsts)

    def test_a_short_working_leaves_a_hole_rather_than_vanishing(self, explore_feed: GtfsFeed) -> None:
        """The whole point of the grid: the trip that stops early is visible."""
        from datetime import date

        from gtfs_garage.core.network import route_timetable

        grid = route_timetable(explore_feed, "2", date(2026, 1, 1))
        short = next(trip for trip in grid["trips"] if trip["trip_id"] == "2-W-short")

        assert short["calls"][0]["departure"] == "07:45:00"
        assert short["calls"][1]["departure"] == "07:51:00"
        assert short["calls"][2] is None

    def test_times_past_midnight_are_kept_and_sort_last(self, explore_feed: GtfsFeed) -> None:
        from datetime import date

        from gtfs_garage.core.network import route_timetable

        grid = route_timetable(explore_feed, "101", date(2026, 1, 2))
        departures = [trip["calls"][0]["departure"] for trip in grid["trips"]]
        assert departures == ["23:00:00", "24:00:00", "25:00:00"]

    def test_a_direction_can_be_asked_for_on_its_own(self, explore_feed: GtfsFeed) -> None:
        from datetime import date

        from gtfs_garage.core.network import route_timetable

        grid = route_timetable(explore_feed, "10", date(2026, 1, 1), direction_id="1")
        assert {trip["direction_id"] for trip in grid["trips"]} == {"1"}
        assert grid["stops"][0]["stop_name"] == "Market Square"

    def test_a_direction_the_route_does_not_run_is_an_error(self, explore_feed: GtfsFeed) -> None:
        from datetime import date

        from gtfs_garage.core.network import UnknownDirectionError, route_timetable

        with pytest.raises(UnknownDirectionError):
            route_timetable(explore_feed, "2", date(2026, 1, 1), direction_id="1")

    def test_a_day_with_no_service_has_no_trips(self, explore_feed: GtfsFeed) -> None:
        from datetime import date

        from gtfs_garage.core.network import route_timetable

        grid = route_timetable(explore_feed, "10", date(2026, 5, 18))
        assert grid["trips"] == []
        assert grid["stops"] == []

    def test_an_exception_day_shows_the_service_it_added(self, explore_feed: GtfsFeed) -> None:
        """2026-04-03 is a Friday that runs the Sunday service, so the regional
        line has a timetable on it and the weekday routes do not."""
        from datetime import date

        from gtfs_garage.core.network import route_timetable

        assert len(route_timetable(explore_feed, "RL", date(2026, 4, 3))["trips"]) == 3
        assert route_timetable(explore_feed, "2", date(2026, 4, 3))["trips"] == []

    def test_an_unknown_route_is_an_error(self, explore_feed: GtfsFeed) -> None:
        from datetime import date

        from gtfs_garage.core.network import route_timetable

        with pytest.raises(UnknownRouteError):
            route_timetable(explore_feed, "nope", date(2026, 1, 1))


class TestADemandResponsiveFeed:
    """A flex feed breaks most of what a fixed-schedule one lets you assume.

    Every case here is one a real feed produced, and three of them were crashes:
    a route list that named a column the feed does not have, a timetable that
    did the same, and a grid that showed one zone twice.
    """

    def test_routes_named_only_by_their_long_name_still_list(self, demand_feed: GtfsFeed) -> None:
        """GTFS requires a short name *or* a long one. Ordering by the missing
        one was a binder error that took the whole route list down."""
        routes = route_list(demand_feed)

        assert [route["route_id"] for route in routes] == ["DAR-GEN", "DAR-SEN"]
        assert routes[0]["short_name"] is None
        assert routes[0]["long_name"] == "Dial-A-Ride - general public"

    def test_booking_windows_stand_in_for_departure_times(self, demand_feed: GtfsFeed) -> None:
        from datetime import date

        from gtfs_garage.core.network import route_timetable

        grid = route_timetable(demand_feed, "DAR-GEN", date(2026, 1, 1))

        assert grid["times_are_windows"] is True
        first = grid["trips"][0]["calls"][0]
        assert (first["arrival"], first["departure"]) == ("05:45:00", "19:45:00")

    def test_columns_order_by_when_a_window_opens_not_when_it_closes(self, demand_feed: GtfsFeed) -> None:
        from datetime import date

        from gtfs_garage.core.network import route_timetable

        grid = route_timetable(demand_feed, "DAR-GEN", date(2026, 1, 1))
        # 05:45-19:45 before 09:00-15:00; ordering by the window end reversed them.
        assert [trip["trip_id"] for trip in grid["trips"]] == ["t-gen-1", "t-gen-2"]

    def test_a_zone_called_at_twice_gets_one_row(self, demand_feed: GtfsFeed) -> None:
        from datetime import date

        from gtfs_garage.core.network import route_timetable

        grid = route_timetable(demand_feed, "DAR-GEN", date(2026, 1, 1))
        assert [stop["stop_id"] for stop in grid["stops"]] == ["grp_north", "area_1"]

    def test_names_come_from_zones_and_groups_when_stops_is_empty(self, demand_feed: GtfsFeed) -> None:
        """`stop_times.stop_id` is a stop, a zone, or a group of zones - and
        this feed's stops.txt has no rows at all."""
        from datetime import date

        from gtfs_garage.core.network import route_timetable

        named = {
            s["stop_id"]: s["stop_name"] for s in route_timetable(demand_feed, "DAR-GEN", date(2026, 1, 1))["stops"]
        }
        assert named["grp_north"] == "North zone"
        assert named["area_1"] == "Riverside zone"

    def test_a_zone_the_feed_does_not_name_keeps_its_id(self, demand_feed: GtfsFeed) -> None:
        from datetime import date

        from gtfs_garage.core.network import route_timetable

        grid = route_timetable(demand_feed, "DAR-SEN", date(2026, 1, 1))
        assert grid["stops"] == [{"stop_id": "area_2", "stop_name": None}]

    def test_the_route_card_opens_on_a_feed_with_no_times(self, demand_feed: GtfsFeed) -> None:
        """It reports no first departure rather than failing to render."""
        detail = route_detail(demand_feed, "DAR-GEN")

        assert detail["timetable"]["first_departure"] is None
        assert len(detail["patterns"]) >= 1

    def test_the_card_does_not_read_a_booking_window_as_a_departure(self, demand_feed: GtfsFeed) -> None:
        """The card's summary is scheduled times only, deliberately.

        Running min and max over a booking window gives "first departure 15:00,
        last arrival 09:00" - inverted nonsense. A demand-responsive route
        genuinely has no first departure; the timetable shows its windows.
        """
        timetable = route_detail(demand_feed, "DAR-GEN")["timetable"]

        assert timetable == {"first_departure": None, "last_arrival": None, "hours": []}
