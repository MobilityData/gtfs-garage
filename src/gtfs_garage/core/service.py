"""When a feed actually runs.

GTFS states service as two files that have to be read together: `calendar.txt`
gives a weekly pattern between two dates, and `calendar_dates.txt` adds or
removes individual days. Neither is readable on its own, and a `service_id` is
an opaque string either way - which is why "does this feed run on Christmas"
is a question nobody can answer by looking at the files.

This module expands the pair into one row per (service, date) and then
summarises it three ways: a trip count per date, a profile per weekday, and
the *service patterns* - groups of dates on which exactly the same set of
services is active, which is what turns fourteen cryptic ids into "Weekday",
"Saturday" and "December 25th only".

Nothing here reads `stop_times`, which is the one file large enough to matter:
a date's trip count is the trip counts per `service_id` - one small group-by -
summed over the services active that day.
"""

from __future__ import annotations

from collections import Counter
from datetime import date as Date
from typing import Any

from gtfs_garage.core.feed import GtfsFeed

# DuckDB's dayofweek() is 0 = Sunday, so this is indexed by it rather than
# written in the order GTFS lists the columns.
WEEKDAY_COLUMNS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

# Monday-first, which is how a timetable is read.
WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
# Spelled out rather than taken from strftime: `%b` is locale-dependent, and a
# payload whose pattern names change with the server's locale cannot be checked
# against a second implementation - or against yesterday's.
MONTH_ABBREVIATIONS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
]

WEEKDAY_NAMES = {
    0: "Sunday",
    1: "Monday",
    2: "Tuesday",
    3: "Wednesday",
    4: "Thursday",
    5: "Friday",
    6: "Saturday",
}

# How far past the first service date the expansion will go. A feed whose
# end_date is a typo - 20991231 appears in the wild - would otherwise generate
# thirty thousand rows per service, and the answer past the third year tells
# nobody anything. The response says when this bit.
MAX_DAYS = 1100

# Beyond this a heat grid is unreadable anyway, and the cost is in the join
# rather than the expansion, so the cap is on the result and not the window.
MAX_DAYS_RETURNED = 1200


class NoCalendarError(LookupError):
    """The feed has neither calendar.txt nor calendar_dates.txt."""


def _has(feed: GtfsFeed, table: str, *columns: str) -> bool:
    present = feed.tables.get(table)
    if present is None:
        return False
    return all(column in present for column in columns)


def _bounds(feed: GtfsFeed) -> tuple[Date, Date, bool]:
    """The first and last date the feed describes, and whether that was cut short.

    Read before anything is expanded, so the expansion can be bounded by a
    WHERE clause rather than by generating rows and throwing them away.
    """
    pieces = []
    if _has(feed, "calendar", "start_date", "end_date"):
        pieces.append("SELECT try_strptime(start_date, '%Y%m%d') AS d FROM calendar")
        pieces.append("SELECT try_strptime(end_date, '%Y%m%d') AS d FROM calendar")
    if _has(feed, "calendar_dates", "date"):
        pieces.append("SELECT try_strptime(date, '%Y%m%d') AS d FROM calendar_dates")
    if not pieces:
        raise NoCalendarError("This feed has no calendar.txt and no calendar_dates.txt.")

    union = " UNION ALL ".join(pieces)
    row = feed.cursor().execute(f"SELECT min(d), max(d) FROM ({union}) WHERE d IS NOT NULL").fetchone()
    if not row or row[0] is None:
        raise NoCalendarError("No readable dates in this feed's calendar.")

    first, last = row[0].date(), row[1].date()
    truncated = (last - first).days > MAX_DAYS
    if truncated:
        last = Date.fromordinal(first.toordinal() + MAX_DAYS)
    return first, last, truncated


def _expansion_sql(feed: GtfsFeed) -> str:
    """SQL producing one (service_id, date) row per day a service runs.

    Written as a single expression so callers can drop it into a CTE: both the
    calendar summary and the per-route profile need the same rows, and
    materialising them twice on a feed with a decade of dates is the one part
    of this that is not free.

    The two halves are not symmetrical. A removal has to be applied to the
    weekly pattern before additions are unioned in, because GTFS lets a feed
    remove a date and add it back under another service - doing it the other
    way round would drop the addition.
    """
    weekly = ""
    if _has(feed, "calendar", "service_id", "start_date", "end_date", *WEEKDAY_COLUMNS):
        runs = " ".join(f"WHEN {index} THEN c.{column}" for index, column in enumerate(WEEKDAY_COLUMNS))
        weekly = f"""
            SELECT c.service_id, CAST(day AS DATE) AS date
            FROM calendar c,
                 UNNEST(generate_series(
                     greatest(try_strptime(c.start_date, '%Y%m%d'), CAST($first AS TIMESTAMP)),
                     least(try_strptime(c.end_date, '%Y%m%d'), CAST($last AS TIMESTAMP)),
                     INTERVAL 1 DAY)) AS series(day)
            WHERE (CASE dayofweek(day) {runs} END) = '1'
        """

    removed = added = ""
    if _has(feed, "calendar_dates", "service_id", "date", "exception_type"):
        both = """
            SELECT service_id, CAST(try_strptime(date, '%Y%m%d') AS DATE) AS date
            FROM calendar_dates
            WHERE exception_type = '{kind}' AND try_strptime(date, '%Y%m%d') IS NOT NULL
        """
        added, removed = both.format(kind="1"), both.format(kind="2")

    if not weekly and not added:
        raise NoCalendarError("This feed's calendar has no usable rows.")

    if weekly and removed:
        weekly = f"SELECT * FROM ({weekly}) EXCEPT SELECT * FROM ({removed})"
    if weekly and added:
        return f"SELECT * FROM ({weekly}) UNION SELECT * FROM ({added})"
    return weekly or added


def _trips_per_service(feed: GtfsFeed, route_id: str | None = None) -> str:
    """Per service: how many trips run, and which routes they belong to.

    The route list travels with the count because "how many routes run that
    day" is the other half of what a calendar is asked, and answering it by
    joining dates to trips directly would fan the trip count out by route.
    Carried as a list and flattened per date instead.
    """
    if not _has(feed, "trips", "service_id"):
        return "SELECT NULL AS service_id, 0 AS trips, [] AS routes WHERE FALSE"

    routes = "list(DISTINCT route_id)" if _has(feed, "trips", "route_id") else "[]"
    where = "WHERE route_id = $route" if route_id is not None else ""
    return f"SELECT service_id, COUNT(*) AS trips, {routes} AS routes FROM trips {where} GROUP BY service_id"


def daily_service(feed: GtfsFeed, route_id: str | None = None) -> list[dict[str, Any]]:
    """Every date the feed covers, with the services active and trips running.

    `route_id` narrows the trip counts to one route while leaving the dates
    alone, which is what a route card needs: a day a route does not run is a
    fact about the route, and dropping the row would hide it.
    """
    first, last, truncated = _bounds(feed)

    if route_id is not None and not _has(feed, "trips", "service_id", "route_id"):
        trips = "SELECT NULL AS service_id, 0 AS trips, [] AS routes WHERE FALSE"
    else:
        trips = _trips_per_service(feed, route_id)

    # Every date in the window, not only the ones something runs on: a day with
    # no service is the single most useful thing a calendar can show, and a
    # query that returns only service days cannot distinguish it from a day
    # outside the feed.
    sql = f"""
        WITH spine AS (
            SELECT CAST(day AS DATE) AS date
            FROM UNNEST(generate_series(
                CAST($first AS TIMESTAMP), CAST($last AS TIMESTAMP), INTERVAL 1 DAY)) AS series(day)
        ),
             dates AS ({_expansion_sql(feed)}),
             counts AS ({trips})
        SELECT s.date,
               COALESCE(
                   list_sort(list(DISTINCT d.service_id) FILTER (WHERE d.service_id IS NOT NULL)),
                   []) AS services,
               CAST(COALESCE(SUM(COALESCE(c.trips, 0)), 0) AS BIGINT) AS trips,
               CAST(length(list_distinct(COALESCE(flatten(list(c.routes)), []))) AS BIGINT) AS routes
        FROM spine s
        LEFT JOIN dates d ON d.date = s.date
        LEFT JOIN counts c ON c.service_id = d.service_id
        GROUP BY s.date
        ORDER BY s.date
        LIMIT {MAX_DAYS_RETURNED}
    """
    parameters: dict[str, Any] = {"first": first, "last": last}
    if route_id is not None:
        parameters["route"] = route_id

    rows = feed.cursor().execute(sql, parameters).fetchall()
    days = [
        {
            "service_date": day.isoformat(),
            "weekday": int(day.strftime("%w")),
            "services": list(services),
            "trips": int(trips_on_day),
            "routes": int(routes_on_day),
        }
        for day, services, trips_on_day, routes_on_day in rows
    ]
    if truncated and days:
        days[-1]["truncated"] = True
    return days


def _pattern_name(dates: list[Date], weekdays: Counter, services: list[str]) -> str:
    """What to call a group of dates that share a set of services.

    Named from the days it falls on rather than from the services in it: a
    reader recognises "Saturday" and has never seen "S_SAT_2024B". A group of
    one date is named by the date, because that is what an exception is.
    """
    if not services:
        return "No service"
    if len(dates) == 1:
        return f"{dates[0].day} {MONTH_ABBREVIATIONS[dates[0].month - 1]} {dates[0].year}"

    covered = {weekday for weekday, count in weekdays.items() if count}
    if covered == {1, 2, 3, 4, 5}:
        return "Weekdays"
    if covered == {0, 6}:
        return "Weekends"
    if len(covered) == 1:
        return f"{WEEKDAY_NAMES[next(iter(covered))]}s"
    if covered == {1, 2, 3, 4, 5, 6}:
        return "Monday to Saturday"
    if len(covered) == 7:
        return "Every day"
    return ", ".join(WEEKDAY_NAMES[day][:3] for day in WEEKDAY_ORDER if day in covered)


def service_patterns(days: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Dates grouped by the exact set of services running on them.

    This is the transformation that makes a calendar legible: a feed with
    fourteen service ids usually has four or five genuinely different days in
    it, and every date is one of them. A group of a single date is almost
    always a holiday, and reads as one.

    Takes the output of `daily_service` rather than querying again - the
    grouping is over at most a few thousand rows and belongs where it can be
    tested without a database.
    """
    groups: dict[tuple[str, ...], dict[str, Any]] = {}
    for day in days:
        key = tuple(day["services"])
        group = groups.setdefault(
            key, {"services": list(key), "dates": [], "weekdays": Counter(), "trips": 0, "routes": 0}
        )
        group["dates"].append(Date.fromisoformat(day["service_date"]))
        group["weekdays"][day["weekday"]] += 1
        # Identical for every date in a group: the same services run, so the
        # same trips do. Assigned rather than summed for that reason.
        group["trips"] = day["trips"]
        group["routes"] = day["routes"]

    patterns = []
    for group in groups.values():
        dates = sorted(group["dates"])
        patterns.append(
            {
                "name": _pattern_name(dates, group["weekdays"], group["services"]),
                "services": group["services"],
                "trips": group["trips"],
                "routes": group["routes"],
                "days": len(dates),
                "weekdays": sorted(weekday for weekday, count in group["weekdays"].items() if count),
                "first_date": dates[0].isoformat(),
                "last_date": dates[-1].isoformat(),
                "sample_dates": [day.isoformat() for day in dates[:5]],
            }
        )
    # Most of the year first: the pattern that covers the most dates is the one
    # someone means by "the schedule", and the one-off exceptions come after.
    return sorted(patterns, key=lambda p: (-p["days"], -p["trips"], p["name"]))


def weekday_profile(days: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """What runs on a Monday, a Tuesday, and so on.

    `typical_trips` is the most common value rather than the mean, because the
    mean of fifty-two Mondays and two public holidays is a number that happens
    on no Monday at all.
    """
    by_weekday: dict[int, list[int]] = {weekday: [] for weekday in WEEKDAY_ORDER}
    for day in days:
        by_weekday[day["weekday"]].append(day["trips"])

    profile = []
    for weekday in WEEKDAY_ORDER:
        counts = by_weekday[weekday]
        running = [count for count in counts if count]
        typical = Counter(running).most_common(1)[0][0] if running else 0
        profile.append(
            {
                "weekday": weekday,
                "name": WEEKDAY_NAMES[weekday],
                "dates": len(counts),
                "dates_with_service": len(running),
                "typical_trips": typical,
                "max_trips": max(counts, default=0),
            }
        )
    return profile


def active_services(feed: GtfsFeed, on_date: Date) -> list[str]:
    """The services running on one date.

    The narrow question behind "what runs on a Tuesday": expanding the whole
    calendar to answer it would read every date in the feed to use one.
    """
    first, last, _ = _bounds(feed)
    if on_date < first or on_date > last:
        return []
    sql = f"SELECT DISTINCT service_id FROM ({_expansion_sql(feed)}) WHERE date = CAST($on AS DATE)"
    rows = feed.cursor().execute(sql, {"first": on_date, "last": on_date, "on": on_date}).fetchall()
    return sorted(str(row[0]) for row in rows if row[0] is not None)


def calendar_summary(feed: GtfsFeed) -> dict[str, Any]:
    """The whole calendar, in the three shapes the interface draws it in."""
    days = daily_service(feed)
    patterns = service_patterns(days)
    return {
        "first_date": days[0]["service_date"] if days else None,
        "last_date": days[-1]["service_date"] if days else None,
        "days": days,
        "patterns": patterns,
        "weekdays": weekday_profile(days),
        "truncated": bool(days and days[-1].get("truncated")),
    }
