"""The calendar expansion and what is read off it.

The cases that matter are the ones a feed gets wrong: an exception that removes
a day the weekly pattern adds, a date added to a service that has no weekly
pattern at all, and an end_date far enough out that expanding it in full would
be a mistake.
"""

from datetime import date, timedelta
from pathlib import Path

import pytest

from gtfs_garage.core.feed import GtfsFeed
from gtfs_garage.core.service import (
    MAX_DAYS,
    NoCalendarError,
    calendar_summary,
    daily_service,
    service_patterns,
    weekday_profile,
)


def write(directory: Path, **files: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        (directory / f"{name}.txt").write_text(content, encoding="utf-8")
    return directory


STOPS = "stop_id,stop_name,stop_lat,stop_lon\nS1,One,45.0,-73.0\n"


def test_expands_a_weekly_pattern_to_dates(explore_feed: GtfsFeed) -> None:
    days = daily_service(explore_feed)
    by_date = {day["service_date"]: day for day in days}

    # 2026-01-01 is a Thursday: the weekday service runs, the weekend ones do not.
    assert by_date["2026-01-01"]["services"] == ["WKDY"]
    # 2026-01-03 is a Saturday, and the night service runs Fridays and Saturdays.
    assert by_date["2026-01-03"]["services"] == ["NIGHT", "SAT"]


def test_every_date_in_the_window_is_present_even_with_no_service(explore_feed: GtfsFeed) -> None:
    """A day nothing runs is the point of the calendar, not a row to drop."""
    days = daily_service(explore_feed)
    quiet = next(day for day in days if day["service_date"] == "2026-05-18")
    assert quiet["services"] == []
    assert quiet["trips"] == 0
    assert len(days) == (date(2026, 6, 30) - date(2026, 1, 1)).days + 1


def test_exceptions_remove_and_add(explore_feed: GtfsFeed) -> None:
    days = {day["service_date"]: day for day in daily_service(explore_feed)}

    # 2026-04-03 is a Friday: WKDY removed, SUN added, NIGHT left alone.
    assert days["2026-04-03"]["services"] == ["NIGHT", "SUN"]
    # 2026-05-18 is a Monday with its only service removed.
    assert days["2026-05-18"]["services"] == []


def test_trips_are_counted_per_date(explore_feed: GtfsFeed) -> None:
    days = {day["service_date"]: day for day in daily_service(explore_feed)}
    # Sundays run the regional line only.
    assert days["2026-01-04"]["trips"] == 3
    assert days["2026-01-01"]["trips"] > days["2026-01-04"]["trips"]


def test_trips_can_be_narrowed_to_one_route(explore_feed: GtfsFeed) -> None:
    """The dates stay; only the counts change. A day a route does not run is a
    fact about the route, and dropping the row would hide it."""
    whole = daily_service(explore_feed)
    one = daily_service(explore_feed, route_id="RL")

    assert len(one) == len(whole)
    assert sum(day["trips"] for day in one) < sum(day["trips"] for day in whole)
    assert next(day for day in one if day["service_date"] == "2026-01-04")["trips"] == 3


def test_patterns_group_dates_by_their_services(explore_feed: GtfsFeed) -> None:
    patterns = {pattern["name"]: pattern for pattern in service_patterns(daily_service(explore_feed))}

    assert patterns["Saturdays"]["services"] == ["NIGHT", "SAT"]
    assert patterns["Sundays"]["services"] == ["SUN"]
    # The one date whose services match nothing else is named by its date.
    assert patterns["3 Apr 2026"]["days"] == 1
    assert patterns["No service"]["services"] == []


def test_patterns_are_ordered_by_how_much_of_the_year_they_cover(explore_feed: GtfsFeed) -> None:
    patterns = service_patterns(daily_service(explore_feed))
    assert patterns == sorted(patterns, key=lambda p: -p["days"])
    assert patterns[0]["days"] >= 100


def test_weekday_profile_reports_the_common_day_not_the_mean(tmp_path: Path) -> None:
    """One holiday must not move what a Monday looks like."""
    directory = write(
        tmp_path / "weekday",
        stops=STOPS,
        calendar=(
            "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
            "WK,1,0,0,0,0,0,0,20260105,20260302\n"
        ),
        calendar_dates="service_id,date,exception_type\nWK,20260202,2\n",
        trips="route_id,service_id,trip_id\n" + "".join(f"R,WK,T{i}\n" for i in range(10)),
    )
    feed = GtfsFeed(str(directory), optimise=False)
    try:
        monday = next(day for day in weekday_profile(daily_service(feed)) if day["name"] == "Monday")
        assert monday["typical_trips"] == 10
        assert monday["dates_with_service"] == monday["dates"] - 1
    finally:
        feed.close()


def test_a_runaway_end_date_is_cut_short(tmp_path: Path) -> None:
    """20991231 is a typo, not seventy years of service."""
    directory = write(
        tmp_path / "runaway",
        stops=STOPS,
        calendar=(
            "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
            "EVERY,1,1,1,1,1,1,1,20260101,20991231\n"
        ),
        trips="route_id,service_id,trip_id\nR,EVERY,T1\n",
    )
    feed = GtfsFeed(str(directory), optimise=False)
    try:
        summary = calendar_summary(feed)
        assert summary["truncated"] is True
        last = date.fromisoformat(summary["last_date"])
        assert last <= date(2026, 1, 1) + timedelta(days=MAX_DAYS)
    finally:
        feed.close()


def test_calendar_dates_alone_is_a_calendar(tmp_path: Path) -> None:
    """GTFS allows a feed with no calendar.txt at all, and plenty use it."""
    directory = write(
        tmp_path / "dates-only",
        stops=STOPS,
        calendar_dates="service_id,date,exception_type\nONE,20260310,1\nONE,20260311,1\n",
        trips="route_id,service_id,trip_id\nR,ONE,T1\nR,ONE,T2\n",
    )
    feed = GtfsFeed(str(directory), optimise=False)
    try:
        summary = calendar_summary(feed)
        assert summary["first_date"] == "2026-03-10"
        assert summary["last_date"] == "2026-03-11"
        assert all(day["trips"] == 2 for day in summary["days"])
    finally:
        feed.close()


def test_a_feed_with_no_calendar_at_all_says_so(tmp_path: Path) -> None:
    directory = write(tmp_path / "nocal", stops=STOPS, trips="route_id,service_id,trip_id\nR,S,T1\n")
    feed = GtfsFeed(str(directory), optimise=False)
    try:
        with pytest.raises(NoCalendarError):
            calendar_summary(feed)
    finally:
        feed.close()


def test_unreadable_dates_are_not_guessed_at(tmp_path: Path) -> None:
    directory = write(
        tmp_path / "junk",
        stops=STOPS,
        calendar=(
            "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
            "BAD,1,1,1,1,1,1,1,not-a-date,also-not\n"
        ),
        trips="route_id,service_id,trip_id\nR,BAD,T1\n",
    )
    feed = GtfsFeed(str(directory), optimise=False)
    try:
        with pytest.raises(NoCalendarError):
            calendar_summary(feed)
    finally:
        feed.close()


def test_a_day_reports_how_many_routes_run_not_only_trips(explore_feed: GtfsFeed) -> None:
    """Two days with the same trip count can be very different days if half the
    network is missing from one of them."""
    days = {day["service_date"]: day for day in daily_service(explore_feed)}

    # A Sunday: the regional line alone. A weekday: the two city routes.
    assert days["2026-01-04"]["routes"] == 1
    assert days["2026-01-01"]["routes"] == 2
    assert days["2026-05-18"]["routes"] == 0


def test_patterns_carry_the_route_count_too(explore_feed: GtfsFeed) -> None:
    patterns = {p["name"]: p for p in service_patterns(daily_service(explore_feed))}
    assert patterns["Sundays"]["routes"] == 1
    assert patterns["Fridays"]["routes"] == 3


def test_active_services_answers_one_date_without_expanding_the_year(explore_feed: GtfsFeed) -> None:
    from datetime import date

    from gtfs_garage.core.service import active_services

    # A Friday with a weekday removal and a Sunday addition: both exceptions
    # have to be applied, in the right order, to get this right.
    assert active_services(explore_feed, date(2026, 4, 3)) == ["NIGHT", "SUN"]
    assert active_services(explore_feed, date(2026, 1, 4)) == ["SUN"]
    assert active_services(explore_feed, date(2026, 5, 18)) == []


def test_a_date_outside_the_window_runs_nothing(explore_feed: GtfsFeed) -> None:
    from datetime import date

    from gtfs_garage.core.service import active_services

    assert active_services(explore_feed, date(2030, 1, 1)) == []
