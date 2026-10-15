"""Routes, the way an operator thinks about them.

A route in GTFS is a row in `routes.txt` and nothing else; everything that
makes it recognisable - where it goes, how often, which days, how many
variants it has - is spread across `trips.txt`, `stop_times.txt` and the
calendar. This module gathers that back into one answer per route.

The expensive file is `stop_times.txt`, so every query here reaches it through
a semi-join on one route's trips and names only the columns it needs. On a
feed of sixty million stop times that is a two-column scan with a filter, not
a read of the file.
"""

from __future__ import annotations

from datetime import date as Date
from typing import Any

from gtfs_garage.core.feed import GtfsFeed
from gtfs_garage.core.overview import _mode_label
from gtfs_garage.core.service import (
    NoCalendarError,
    active_services,
    daily_service,
    service_patterns,
    weekday_profile,
)

# How many stop-sequence variants to describe. A route with more than this is
# either a flex service or a data problem, and either way the long tail is not
# what the page is for.
MAX_PATTERNS = 12

# How many trips a timetable will draw as columns. A route-day with more than
# this is a trunk corridor every two minutes, where the hundredth column tells
# nobody anything the tenth did not; the response says it was cut.
MAX_TIMETABLE_TRIPS = 400

# GTFS times run past midnight - 25:10:00 is a valid departure on the service
# day before - so they are parsed as an offset in seconds rather than a clock
# time, which is also what makes them sortable.
SECONDS = """
    (COALESCE(try_cast(split_part({column}, ':', 1) AS BIGINT), 0) * 3600
   + COALESCE(try_cast(split_part({column}, ':', 2) AS BIGINT), 0) * 60
   + COALESCE(try_cast(split_part({column}, ':', 3) AS BIGINT), 0))
"""


class UnknownRouteError(LookupError):
    """The feed has no route with that id."""


def _has(feed: GtfsFeed, table: str, *columns: str) -> bool:
    present = feed.tables.get(table)
    return present is not None and all(column in present for column in columns)


def _column(feed: GtfsFeed, table: str, column: str, alias: str | None = None) -> str:
    """`column`, or a NULL standing in for it when this feed has no such column.

    Half of GTFS's columns are optional, and a SELECT naming one a feed lacks
    fails the whole query. This keeps the shape of the answer constant.
    """
    name = alias or column
    return f'"{column}" AS {name}' if _has(feed, table, column) else f"NULL AS {name}"


def _seconds(time: str | None) -> int | None:
    """A GTFS time as seconds since the service day began, or None.

    Past 24:00:00 is ordinary and kept: a trip leaving at 25:10 belongs to the
    service day before, and wrapping it would sort it to the front of a
    timetable it ends.
    """
    if not time:
        return None
    parts = time.split(":")
    try:
        numbers = [int(part) for part in parts[:3]]
    except ValueError:
        return None
    while len(numbers) < 3:
        numbers.append(0)
    return numbers[0] * 3600 + numbers[1] * 60 + numbers[2]


def _clock(seconds: int | None) -> str | None:
    """Seconds since the service day began, back as GTFS would write them."""
    if seconds is None:
        return None
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def route_list(feed: GtfsFeed, on_date: Date | None = None) -> list[dict[str, Any]]:
    """Every route with what it is, who runs it and how much of it there is.

    Deliberately does not touch `stop_times`: this is a list of a few hundred
    rows that has to appear instantly, and the per-route detail is a click
    away for the one route someone actually wants.

    `on_date` narrows it to the routes running that day, which is what turns a
    date on the calendar into something to look at - on the map, or as a list.
    A route the feed has but that runs on no service that day is absent rather
    than present with a zero.
    """
    if "routes" not in feed.tables:
        return []

    running = ""
    parameters: list[Any] = []
    if on_date is not None:
        if not _has(feed, "trips", "route_id", "service_id"):
            return []
        try:
            services = active_services(feed, on_date)
        except NoCalendarError:
            return []
        if not services:
            return []
        placeholders = ", ".join(["?"] * len(services))
        running = f"WHERE r.route_id IN (SELECT DISTINCT route_id FROM trips WHERE service_id IN ({placeholders}))"
        parameters = list(services)

    trips = (
        "LEFT JOIN (SELECT route_id, COUNT(*) AS n, COUNT(DISTINCT service_id) AS services "
        "FROM trips GROUP BY route_id) t USING (route_id)"
        if _has(feed, "trips", "route_id")
        else ""
    )
    agency = (
        "LEFT JOIN (SELECT agency_id, agency_name FROM agency) a USING (agency_id)"
        if _has(feed, "routes", "agency_id") and _has(feed, "agency", "agency_id", "agency_name")
        else ""
    )

    # A feed that states one is telling you the order it wants; the rest is
    # the fallback for the many that do not.
    stated_order = (
        "try_cast(r.route_sort_order AS BIGINT) NULLS LAST," if _has(feed, "routes", "route_sort_order") else ""
    )

    # GTFS requires a short name *or* a long one, not both, so neither column
    # can be named unconditionally. Ordering by one a feed does not have is a
    # binder error that takes the whole route list down - which is how a
    # perfectly valid flex feed, named only by its long names, answered 500.
    if _has(feed, "routes", "route_short_name"):
        by_name = (
            "try_cast(regexp_extract(COALESCE(r.route_short_name, ''), '^[0-9]+') AS BIGINT) NULLS LAST,"
            " COALESCE(r.route_short_name, ''),"
        )
    elif _has(feed, "routes", "route_long_name"):
        by_name = "COALESCE(r.route_long_name, ''),"
    else:
        by_name = ""

    sql = f"""
        SELECT r.route_id,
               {_column(feed, "routes", "route_short_name", "short_name")},
               {_column(feed, "routes", "route_long_name", "long_name")},
               {_column(feed, "routes", "route_type", "route_type")},
               {_column(feed, "routes", "route_color", "color")},
               {_column(feed, "routes", "route_text_color", "text_color")},
               {_column(feed, "routes", "agency_id", "agency_id")},
               {"a.agency_name" if agency else "NULL"} AS agency_name,
               COALESCE({"t.n" if trips else "0"}, 0) AS trips,
               COALESCE({"t.services" if trips else "0"}, 0) AS services
        FROM routes r {trips} {agency}
        {running}
        ORDER BY {stated_order} {by_name} r.route_id
    """
    rows = feed.cursor().execute(sql, parameters).fetchall()
    columns = [
        "route_id",
        "short_name",
        "long_name",
        "route_type",
        "color",
        "text_color",
        "agency_id",
        "agency_name",
        "trips",
        "services",
    ]
    routes = []
    for row in rows:
        route = dict(zip(columns, row))
        route["trips"] = int(route["trips"] or 0)
        route["services"] = int(route["services"] or 0)
        route["mode"] = _mode_label(route["route_type"])
        routes.append(route)
    return routes


def _route_row(feed: GtfsFeed, route_id: str) -> dict[str, Any]:
    columns = feed.tables.get("routes") or []
    if not columns:
        raise UnknownRouteError(route_id)
    selected = ", ".join(f'"{column}"' for column in columns)
    row = feed.cursor().execute(f"SELECT {selected} FROM routes WHERE route_id = ?", [route_id]).fetchone()
    if row is None:
        raise UnknownRouteError(route_id)
    return dict(zip(columns, row))


def _directions(feed: GtfsFeed, route_id: str) -> list[dict[str, Any]]:
    """The route's two halves, with what the vehicle shows on each.

    `direction_id` is optional, and plenty of feeds leave it empty; a route
    with none comes back as one unnamed direction rather than as nothing.
    """
    if not _has(feed, "trips", "route_id"):
        return []
    # COALESCE around each: a FILTER that excludes every row makes `list()`
    # return NULL rather than an empty list, and a route whose trips all leave
    # shape_id empty is ordinary - a feed without shapes.txt has nothing else.
    headsign = (
        "COALESCE(list_sort(list(DISTINCT trip_headsign) "
        "FILTER (WHERE trip_headsign IS NOT NULL AND trip_headsign != '')), [])"
        if _has(feed, "trips", "trip_headsign")
        else "[]"
    )
    shapes = (
        "COALESCE(list_sort(list(DISTINCT shape_id) " "FILTER (WHERE shape_id IS NOT NULL AND shape_id != '')), [])"
        if _has(feed, "trips", "shape_id")
        else "[]"
    )
    direction = '"direction_id"' if _has(feed, "trips", "direction_id") else "NULL"
    rows = (
        feed.cursor()
        .execute(
            f"""
        SELECT {direction} AS direction_id, COUNT(*) AS trips, {headsign} AS headsigns, {shapes} AS shapes
        FROM trips WHERE route_id = ? GROUP BY 1 ORDER BY 1
        """,
            [route_id],
        )
        .fetchall()
    )
    return [
        {
            "direction_id": direction_id,
            "trips": int(trips),
            "headsigns": list(headsigns)[:6],
            # Capped: a route whose every trip has its own shape would
            # otherwise hand the map thousands of ids to fetch at once.
            "shape_ids": list(shapes)[:40],
        }
        for direction_id, trips, headsigns, shapes in rows
    ]


def _patterns(feed: GtfsFeed, route_id: str) -> list[dict[str, Any]]:
    """The distinct stop sequences the route's trips actually follow.

    GTFS has no name for this and operators have several - pattern, variant,
    journey pattern - but it is the thing they check first: a route that looks
    like one line on a map is usually four slightly different ones, and a
    sequence followed by a single trip is where the mistakes are.
    """
    if not (_has(feed, "stop_times", "trip_id", "stop_id", "stop_sequence") and _has(feed, "trips", "route_id")):
        return []

    direction = "t.direction_id" if _has(feed, "trips", "direction_id") else "NULL"
    headsign = "t.trip_headsign" if _has(feed, "trips", "trip_headsign") else "NULL"
    rows = (
        feed.cursor()
        .execute(
            f"""
        WITH route_trips AS (
            SELECT trip_id, {direction} AS direction_id, {headsign} AS headsign FROM trips t WHERE route_id = ?
        ),
        sequences AS (
            SELECT st.trip_id,
                   list(st.stop_id ORDER BY try_cast(st.stop_sequence AS BIGINT)) AS stops
            FROM stop_times st
            WHERE st.trip_id IN (SELECT trip_id FROM route_trips)
            GROUP BY st.trip_id
        )
        -- min() rather than any_value(): the latter picks whichever row the engine
        -- reached first, so the same feed produced a different example trip on
        -- each run and in each implementation. A payload that changes without
        -- the data changing cannot be cached, diffed or checked.
        SELECT s.stops,
               min(rt.direction_id) AS direction_id,
               min(rt.headsign) AS headsign,
               COUNT(*) AS trips,
               min(s.trip_id) AS example_trip
        FROM sequences s JOIN route_trips rt USING (trip_id)
        GROUP BY s.stops
        ORDER BY trips DESC, len(s.stops) DESC
        LIMIT {MAX_PATTERNS}
        """,
            [route_id],
        )
        .fetchall()
    )

    names = _stop_names(feed, {stop for row in rows for stop in row[0]})
    return [
        {
            "direction_id": direction_id,
            "headsign": headsign,
            "trips": int(trips),
            "example_trip_id": example_trip,
            "stops": [{"stop_id": stop_id, "stop_name": names.get(stop_id)} for stop_id in stops],
        }
        for stops, direction_id, headsign, trips, example_trip in rows
    ]


def _stop_names(feed: GtfsFeed, stop_ids: set[str]) -> dict[str, str]:
    """Names for the places a trip calls at, wherever the feed keeps them.

    `stop_times.stop_id` is three things at once in GTFS-Flex: a stop, a zone
    from `locations.geojson`, or a group of zones from `location_groups.txt`.
    Looking in only the first leaves a demand-responsive route listing raw ids
    where a reader expects "Fillmore and Piru" - which is what a real flex feed
    did, because its `stops.txt` is empty.

    Not every one has a name to give: a zone whose GeoJSON carries no
    `stop_name` is reported by its id, which is what the feed actually says.
    """
    if not stop_ids:
        return {}

    names: dict[str, str] = {}
    placeholders = ", ".join(["?"] * len(stop_ids))
    sources = [
        ("stops", "stop_id", "stop_name"),
        ("location_groups", "location_group_id", "location_group_name"),
        ("locations", "id", "stop_name"),
    ]

    for table, key, label in sources:
        if not _has(feed, table, key, label):
            continue
        rows = (
            feed.cursor()
            .execute(
                f'SELECT "{key}", "{label}" FROM "{table}" WHERE "{key}" IN ({placeholders})',
                list(stop_ids),
            )
            .fetchall()
        )
        # In order, so a stop is never shadowed by a zone sharing its id.
        for identifier, name in rows:
            if name and identifier not in names:
                names[identifier] = name
    return names


def _timetable_shape(feed: GtfsFeed, route_id: str) -> dict[str, Any]:
    """When the route starts, when it stops, and when its trips leave.

    The hour histogram counts each trip once, at the hour it leaves its first
    stop, which is the count an operator means by "trips per hour". Hours run
    past 23 because GTFS times do: a trip leaving at 25:10 belongs to the
    service day before, not to the next morning.
    """
    if not (_has(feed, "stop_times", "trip_id", "departure_time", "stop_sequence") and _has(feed, "trips", "route_id")):
        return {"first_departure": None, "last_arrival": None, "hours": []}

    arrival = "arrival_time" if _has(feed, "stop_times", "arrival_time") else "departure_time"
    departure_seconds = SECONDS.format(column="st.departure_time")
    arrival_seconds = SECONDS.format(column=f"st.{arrival}")

    row = (
        feed.cursor()
        .execute(
            f"""
        WITH route_trips AS (SELECT trip_id FROM trips WHERE route_id = ?),
        stops_on_route AS (
            SELECT st.trip_id,
                   try_cast(st.stop_sequence AS BIGINT) AS seq,
                   CASE WHEN st.departure_time IS NULL OR st.departure_time = ''
                        THEN NULL ELSE {departure_seconds} END AS departs,
                   CASE WHEN st.{arrival} IS NULL OR st.{arrival} = ''
                        THEN NULL ELSE {arrival_seconds} END AS arrives
            FROM stop_times st
            WHERE st.trip_id IN (SELECT trip_id FROM route_trips)
        ),
        per_trip AS (
            SELECT trip_id,
                   min_by(departs, seq) FILTER (WHERE departs IS NOT NULL) AS first_departure,
                   max_by(arrives, seq) FILTER (WHERE arrives IS NOT NULL) AS last_arrival
            FROM stops_on_route GROUP BY trip_id
        )
        SELECT min(first_departure), max(last_arrival),
               list_sort(list(DISTINCT first_departure // 3600) FILTER (WHERE first_departure IS NOT NULL)) AS hours,
               list(first_departure) FILTER (WHERE first_departure IS NOT NULL) AS departures
        FROM per_trip
        """,
            [route_id],
        )
        .fetchone()
    )

    first, last, _hours, departures = row if row else (None, None, [], [])
    histogram: dict[int, int] = {}
    for departure in departures or []:
        histogram[int(departure) // 3600] = histogram.get(int(departure) // 3600, 0) + 1

    return {
        "first_departure": _clock(int(first) if first is not None else None),
        "last_arrival": _clock(int(last) if last is not None else None),
        "hours": [{"hour": hour, "trips": histogram[hour]} for hour in sorted(histogram)],
    }


def route_detail(feed: GtfsFeed, route_id: str, on_date: Date | None = None) -> dict[str, Any]:
    """Everything one route's page shows.

    The calendar half reuses the feed-wide expansion narrowed to this route, so
    "which days does the 14 run" is answered by the same code that answers it
    for the feed - there is no second notion of a service day here.

    `on_date` adds what the route does on one day, which is the number a reader
    with a date in mind is actually asking for. It costs nothing: the per-date
    counts are already computed for the weekday profile, so this is a lookup
    rather than another read.
    """
    route = _route_row(feed, route_id)
    directions = _directions(feed, route_id)

    try:
        days = daily_service(feed, route_id=route_id)
    except NoCalendarError:
        days = []

    running = [day for day in days if day["trips"]]

    chosen = None
    if on_date is not None:
        wanted = on_date.isoformat()
        chosen = next((day for day in days if day["service_date"] == wanted), None)

    return {
        # What the route does on the day being looked at, beside what it does
        # across the feed. None when no day was named, and zero - rather than
        # None - on a day the route does not run, which is an answer.
        "day": None if chosen is None else {"service_date": chosen["service_date"], "trips": chosen["trips"]},
        "route": route,
        "mode": _mode_label(route.get("route_type")),
        "agency_name": _agency_name(feed, route.get("agency_id")),
        "trips": sum(direction["trips"] for direction in directions),
        "directions": directions,
        "patterns": _patterns(feed, route_id),
        "timetable": _timetable_shape(feed, route_id),
        "weekdays": weekday_profile(days),
        "service_patterns": [pattern for pattern in service_patterns(days) if pattern["trips"]],
        "first_date": running[0]["service_date"] if running else None,
        "last_date": running[-1]["service_date"] if running else None,
        "days_running": len(running),
    }


def _agency_name(feed: GtfsFeed, agency_id: str | None) -> str | None:
    if not _has(feed, "agency", "agency_name"):
        return None
    if agency_id and _has(feed, "agency", "agency_id"):
        row = feed.cursor().execute("SELECT agency_name FROM agency WHERE agency_id = ?", [agency_id]).fetchone()
        if row:
            return row[0]
    # A single-agency feed is allowed to omit agency_id everywhere, and then
    # the one agency is the answer.
    row = feed.cursor().execute("SELECT agency_name FROM agency LIMIT 2").fetchall()
    return row[0][0] if len(row) == 1 else None


# Where a call's times live, in the order they are preferred.
#
# A fixed-schedule feed states `arrival_time` and `departure_time`. A flex one
# often states neither: a demand-responsive trip has a window it can be booked
# in rather than a time it calls, and GTFS-Flex says so in its own columns. The
# older spelling without the underscores is in the wild and reads the same, so
# both are accepted.
TIME_COLUMNS = {
    "arrival": ["arrival_time", "start_pickup_drop_off_window", "start_pickup_dropoff_window"],
    "departure": ["departure_time", "end_pickup_drop_off_window", "end_pickup_dropoff_window"],
}


def _time_columns(feed: GtfsFeed) -> tuple[str, str, bool]:
    """The columns a timetable reads its times from, and what they mean.

    Returns SQL expressions rather than names, so a feed stating none of them -
    which is valid, and which used to be a binder error that took the whole
    view down - yields NULL instead of naming a column that is not there.
    """

    def first(kind: str) -> str | None:
        return next((name for name in TIME_COLUMNS[kind] if _has(feed, "stop_times", name)), None)

    arrival, departure = first("arrival"), first("departure")
    windows = arrival not in (None, "arrival_time") or departure not in (None, "departure_time")
    return (
        f'st."{arrival}"' if arrival else "NULL",
        f'st."{departure}"' if departure else "NULL",
        bool(windows and (arrival or departure)),
    )


class UnknownDirectionError(LookupError):
    """The route has no trips in that direction on that day."""


def _spine(sequences: list[list[str]]) -> list[str]:
    """One stop order covering every trip, built from the longest of them.

    A route's trips do not all call everywhere: the short working stops early,
    the express skips the middle, the school journey adds two stops nobody else
    sees. A grid needs one row order that holds all of them, and the honest way
    to build it is to start from the longest sequence and weave the rest in
    where they belong - after the stop they follow - rather than appending the
    odd ones at the bottom where they would read as the end of the line.

    A stop a trip calls at twice - a loop that passes its own terminus - gets
    one row rather than two. That is a real limitation of a stops-by-trips grid
    and not something this can fix; the trip's own times are still correct in
    the row it lands in.
    """
    if not sequences:
        return []

    # Deduped as it is seeded, not only as it is woven: a loop whose longest
    # trip passes its own terminus would otherwise get two rows for one stop,
    # both showing the same times.
    seed = max(sequences, key=len)
    spine: list[str] = []
    for stop in seed:
        if stop not in spine:
            spine.append(stop)
    positions = {stop: index for index, stop in enumerate(spine)}

    for sequence in sequences:
        previous = -1
        for stop in sequence:
            if stop in positions:
                previous = positions[stop]
                continue
            # Insert after the last stop of this trip that the spine already
            # knows, which is where this one happens on the ground.
            at = previous + 1
            spine.insert(at, stop)
            positions = {name: index for index, name in enumerate(spine)}
            previous = at

    return spine


def route_timetable(
    feed: GtfsFeed,
    route_id: str,
    on_date: Date,
    direction_id: str | None = None,
) -> dict[str, Any]:
    """One route's departures on one day, as stops by trips.

    The artefact an operator recognises and the one GTFS makes hardest to see:
    the times live in `stop_times.txt` keyed by trip, the trips live in
    `trips.txt` keyed by service, and which services run on a Tuesday is two
    more files away. This answers all of it at once for a single route-day.

    Read through a semi-join on this route's own trips, narrowed to the day's
    services *inside* that CTE - which is what keeps it a filtered scan of five
    columns rather than a read of the largest file in the feed.
    """
    route = _route_row(feed, route_id)

    empty = {
        "route_id": route_id,
        "direction_id": direction_id,
        "service_date": on_date.isoformat(),
        "route_short_name": route.get("route_short_name"),
        "route_long_name": route.get("route_long_name"),
        "stops": [],
        "trips": [],
        "truncated": False,
        "times_are_windows": False,
    }
    if not (_has(feed, "stop_times", "trip_id", "stop_id", "stop_sequence") and _has(feed, "trips", "route_id")):
        return empty

    try:
        services = active_services(feed, on_date)
    except NoCalendarError:
        return empty
    if not services or not _has(feed, "trips", "service_id"):
        return empty

    conditions = ["route_id = ?", f"service_id IN ({', '.join(['?'] * len(services))})"]
    parameters: list[Any] = [route_id, *services]
    if direction_id is not None and _has(feed, "trips", "direction_id"):
        conditions.append("direction_id = ?")
        parameters.append(direction_id)

    arrival, departure, windows = _time_columns(feed)

    rows = (
        feed.cursor()
        .execute(
            f"""
        WITH route_trips AS (
            SELECT trip_id,
                   {_column(feed, "trips", "direction_id", "direction_id")},
                   {_column(feed, "trips", "trip_headsign", "headsign")},
                   {_column(feed, "trips", "service_id", "service_id")},
                   {_column(feed, "trips", "block_id", "block_id")}
            FROM trips WHERE {" AND ".join(conditions)}
        ),
        calls AS (
            SELECT st.trip_id,
                   st.stop_id,
                   try_cast(st.stop_sequence AS BIGINT) AS seq,
                   {arrival} AS arrives,
                   {departure} AS departs
            FROM stop_times st
            WHERE st.trip_id IN (SELECT trip_id FROM route_trips)
        )
        SELECT c.trip_id, rt.direction_id, rt.headsign, rt.service_id, rt.block_id,
               c.stop_id, c.seq, c.arrives, c.departs
        FROM calls c JOIN route_trips rt USING (trip_id)
        ORDER BY c.trip_id, c.seq
        """,
            parameters,
        )
        .fetchall()
    )

    if not rows:
        if direction_id is not None:
            raise UnknownDirectionError(direction_id)
        return empty

    trips: dict[str, dict[str, Any]] = {}
    for trip_id, direction, headsign, service_id, block_id, stop_id, seq, arrives, departs in rows:
        trip = trips.setdefault(
            trip_id,
            {
                "trip_id": trip_id,
                "direction_id": direction,
                "headsign": headsign,
                "service_id": service_id,
                "block_id": block_id,
                "sequence": [],
                "calls": {},
            },
        )
        trip["sequence"].append(stop_id)
        trip["calls"][stop_id] = {
            "arrival": arrives or None,
            "departure": departs or None,
            "stop_sequence": None if seq is None else int(seq),
        }

    spine = _spine([trip["sequence"] for trip in trips.values()])

    def leaves(trip: dict[str, Any]) -> int:
        """Seconds at the trip's first call, for ordering the columns.

        The earliest of the two times rather than the departure: for a booking
        window the departure *is* the end of the window, so ordering by it put
        a trip bookable 09:00-15:00 before one bookable from 05:45.

        Trips with no time at all sort last rather than first: a feed with
        empty times should not put its unusable columns at the front of every
        timetable.
        """
        for stop_id in trip["sequence"]:
            call = trip["calls"][stop_id]
            times = [_seconds(call["arrival"]), _seconds(call["departure"])]
            known = [value for value in times if value is not None]
            if known:
                return min(known)
        return 1 << 30

    ordered = sorted(trips.values(), key=lambda trip: (leaves(trip), trip["trip_id"]))
    truncated = len(ordered) > MAX_TIMETABLE_TRIPS
    names = _stop_names(feed, set(spine))

    return {
        "route_id": route_id,
        "direction_id": direction_id,
        "service_date": on_date.isoformat(),
        "route_short_name": route.get("route_short_name"),
        "route_long_name": route.get("route_long_name"),
        # True when the times are booking windows rather than scheduled calls,
        # so a reader is not shown "05:45" for a service that runs on demand
        # between 05:45 and 19:45.
        "times_are_windows": windows,
        "stops": [{"stop_id": stop_id, "stop_name": names.get(stop_id)} for stop_id in spine],
        "trips": [
            {
                "trip_id": trip["trip_id"],
                "direction_id": trip["direction_id"],
                "headsign": trip["headsign"],
                "service_id": trip["service_id"],
                "block_id": trip["block_id"],
                # Aligned to `stops`, so a cell is a column index away and a
                # trip that does not call somewhere leaves a hole rather than
                # being squeezed out of the grid.
                "calls": [trip["calls"].get(stop_id) for stop_id in spine],
            }
            for trip in ordered[:MAX_TIMETABLE_TRIPS]
        ],
        "truncated": truncated,
    }
