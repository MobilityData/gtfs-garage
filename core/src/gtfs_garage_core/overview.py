"""What is in this feed, said in the words of someone who has not read it.

The file list answers "which files are here". This answers the question people
actually arrive with - who runs this, what do they run, when does it run, and
what is this feed going to be able to tell me - without naming a file at all.

Everything here is a count or a short list, and every one of them is also a
place to go: the interface turns each into a link back into the rows it came
from, so the friendly summary and the raw file browser are two views of the
same thing rather than two tools.
"""

from __future__ import annotations

from datetime import date as Date
from typing import Any

from gtfs_garage_core.feed import GtfsFeed
from gtfs_garage_core.schema import field_info
from gtfs_garage_core.service import NoCalendarError, _bounds

# What a feed can carry beyond the basics, and the evidence that it does.
# Named as a reader would describe the capability rather than as GTFS names the
# file, because "this feed has fares" is the fact and `fare_leg_rules.txt` is
# only the evidence. An entry is `table` or `table.column`: some capabilities
# are a file, and some are a column on a file every feed already has.
FEATURES: list[tuple[str, str, list[str]]] = [
    ("Route shapes", "Lines on the map rather than straight hops between stops.", ["shapes"]),
    ("Frequencies", "Service stated as a headway over a window instead of trip by trip.", ["frequencies"]),
    ("Fares v2", "Fares as products, media and leg rules.", ["fare_products", "fare_leg_rules", "fare_media"]),
    ("Fares v1", "The original fare model: attributes and rules.", ["fare_attributes", "fare_rules"]),
    ("Transfers", "Where and how riders change between services.", ["transfers"]),
    ("Pathways", "Walking connections inside stations.", ["pathways", "levels"]),
    ("Flex", "On-demand zones and booking rules.", ["locations", "booking_rules", "location_groups"]),
    ("Translations", "Names and descriptions in more than one language.", ["translations"]),
    (
        "Accessibility",
        "Whether a stop can be boarded and a trip ridden in a wheelchair.",
        ["stops.wheelchair_boarding", "trips.wheelchair_accessible"],
    ),
    ("Headsigns", "What the vehicle displays, which is what a rider looks for.", ["trips.trip_headsign"]),
]


def _count(feed: GtfsFeed, sql: str, parameters: list[Any] | None = None) -> int:
    """A scalar count, or zero when the query cannot run against this feed.

    A feed missing a file is the ordinary case rather than an error here: the
    overview says "no shapes" by counting zero of them.
    """
    try:
        row = feed.cursor().execute(sql, parameters or []).fetchone()
    except Exception:
        return 0
    return int(row[0]) if row and row[0] is not None else 0


def _has(feed: GtfsFeed, table: str, *columns: str) -> bool:
    present = feed.tables.get(table)
    return present is not None and all(column in present for column in columns)


def _row(feed: GtfsFeed, table: str, columns: list[str]) -> dict[str, Any]:
    """The first row of a one-row file, as a dict of the columns it has."""
    wanted = [column for column in columns if _has(feed, table, column)]
    if not wanted:
        return {}
    selected = ", ".join(f'"{column}"' for column in wanted)
    try:
        row = feed.cursor().execute(f'SELECT {selected} FROM "{table}" LIMIT 1').fetchone()
    except Exception:
        return {}
    return dict(zip(wanted, row)) if row else {}


def _mode_label(route_type: str | None) -> str:
    """The mode a route_type names.

    GTFS's own ten values come from the schema. The extended set - the 100s and
    700s a European feed uses - is not in the reference's enumeration, so those
    are reported by their number rather than guessed at.
    """
    values = field_info("routes", "route_type").get("values", {})
    if route_type in values:
        return values[route_type]
    return f"Type {route_type}" if route_type else "Unspecified"


def _agencies(feed: GtfsFeed) -> list[dict[str, Any]]:
    if not _has(feed, "agency", "agency_name"):
        return []
    has_id = _has(feed, "agency", "agency_id")
    identifier = "agency_id" if has_id else "NULL"
    # Left joined on the agency id, so an agency that runs nothing still
    # appears: a feed with an unused agency is a finding, not a row to drop.
    routes_join = ""
    if has_id and _has(feed, "routes", "agency_id"):
        routes_join = "LEFT JOIN (SELECT agency_id, COUNT(*) AS n FROM routes GROUP BY agency_id) r USING (agency_id)"
    elif _has(feed, "routes", "route_id"):
        routes_join = "LEFT JOIN (SELECT COUNT(*) AS n FROM routes) r ON TRUE"

    timezone = "agency_timezone" if _has(feed, "agency", "agency_timezone") else "NULL"
    url = "agency_url" if _has(feed, "agency", "agency_url") else "NULL"
    sql = f"""
        SELECT {identifier} AS agency_id, agency_name, {timezone} AS tz, {url} AS url,
               COALESCE({"r.n" if routes_join else "0"}, 0) AS routes
        FROM agency {routes_join}
        ORDER BY agency_name
    """
    try:
        rows = feed.cursor().execute(sql).fetchall()
    except Exception:
        return []
    return [
        {"agency_id": agency_id, "name": name, "timezone": tz, "url": url, "routes": int(routes)}
        for agency_id, name, tz, url, routes in rows
    ]


def _modes(feed: GtfsFeed) -> list[dict[str, Any]]:
    """Routes grouped by what they are - the first thing anyone wants to know."""
    if not _has(feed, "routes", "route_type"):
        return []
    rows = (
        feed.cursor().execute("SELECT route_type, COUNT(*) FROM routes GROUP BY route_type ORDER BY 2 DESC").fetchall()
    )
    return [
        {"route_type": route_type, "label": _mode_label(route_type), "routes": int(count)} for route_type, count in rows
    ]


def _service_window(feed: GtfsFeed) -> dict[str, Any]:
    """When this feed is good for, and how long that still has to run.

    The expiry is the fact an operator is usually looking for and the one the
    files are worst at showing: it is the maximum of a column of eight-digit
    strings spread over two files.
    """
    try:
        first, last, truncated = _bounds(feed)
    except NoCalendarError as exc:
        return {"first_date": None, "last_date": None, "days_remaining": None, "note": str(exc)}
    today = Date.today()
    return {
        "first_date": first.isoformat(),
        "last_date": last.isoformat(),
        "days_remaining": (last - today).days,
        "truncated": truncated,
    }


def _features(feed: GtfsFeed) -> list[dict[str, Any]]:
    """Which optional parts of GTFS this feed uses, and what each is for.

    Reported present or absent rather than only present: "no shapes" is the
    answer to a question someone asked, and leaving the row out looks like the
    tool failed to check.
    """

    def found(evidence: str) -> str | None:
        table, _, column = evidence.partition(".")
        if not _has(feed, table, *(c for c in [column] if c)):
            return None
        return table

    results = []
    for name, description, evidence in FEATURES:
        tables = sorted({table for table in (found(item) for item in evidence) if table})
        results.append({"name": name, "description": description, "present": bool(tables), "tables": tables})
    return results


def feed_overview(feed: GtfsFeed) -> dict[str, Any]:
    """The landing page's whole payload."""
    published = _row(
        feed,
        "feed_info",
        ["feed_publisher_name", "feed_publisher_url", "feed_lang", "feed_version", "feed_start_date", "feed_end_date"],
    )

    # Stops only, not stations, entrances or the rest of location_type: "how
    # many stops" means places a rider boards, and counting a station's node
    # alongside its platforms inflates every feed that models stations.
    boarding = "SELECT COUNT(*) FROM stops"
    if _has(feed, "stops", "location_type"):
        boarding += " WHERE location_type IS NULL OR location_type IN ('', '0')"

    counts = {
        "routes": _count(feed, "SELECT COUNT(*) FROM routes") if "routes" in feed.tables else 0,
        "stops": _count(feed, boarding) if "stops" in feed.tables else 0,
        "stations": (
            _count(feed, "SELECT COUNT(*) FROM stops WHERE location_type = '1'")
            if _has(feed, "stops", "location_type")
            else 0
        ),
        "trips": _count(feed, "SELECT COUNT(*) FROM trips") if "trips" in feed.tables else 0,
        "stop_times": _count(feed, "SELECT COUNT(*) FROM stop_times") if "stop_times" in feed.tables else 0,
        "shapes": (
            _count(feed, "SELECT COUNT(DISTINCT shape_id) FROM shapes") if _has(feed, "shapes", "shape_id") else 0
        ),
        "services": (
            _count(feed, "SELECT COUNT(DISTINCT service_id) FROM trips") if _has(feed, "trips", "service_id") else 0
        ),
        # A demand-responsive feed has no stops and no shapes; it has zones a
        # rider is picked up in, and named groups of them. Counting only the
        # other model makes a working flex feed read as an empty one.
        "zones": _count(feed, "SELECT COUNT(*) FROM locations") if "locations" in feed.tables else 0,
        "location_groups": (
            _count(feed, "SELECT COUNT(DISTINCT location_group_id) FROM location_groups")
            if _has(feed, "location_groups", "location_group_id")
            else 0
        ),
    }

    return {
        "published": published,
        "agencies": _agencies(feed),
        "modes": _modes(feed),
        "counts": counts,
        "service": _service_window(feed),
        "features": _features(feed),
    }
