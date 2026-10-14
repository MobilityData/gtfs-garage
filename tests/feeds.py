"""Building a GTFS feed of a requested size.

Its own module rather than part of `conftest.py` because it is imported from
outside the test suite: `scripts/benchmark.py` generates its feed with this, and
CI copies this file into a harness that it then runs against *another commit's*
installed package - so anything it imports has to exist in both. Nothing here
imports `gtfs_garage` at all, which is what makes that safe.
"""

from __future__ import annotations

from pathlib import Path


def write_feed(directory: Path, stops: int, shapes: int, points_per_shape: int, routes: int | None = None) -> Path:
    """A synthetic GTFS feed of a requested size.

    Deterministic, and built from arithmetic rather than randomness so two runs
    produce byte-identical files. Used by the performance guards, which need to
    compare behaviour across feed sizes rather than assert against one fixture.

    `routes` defaults to one per shape. Fewer leaves the rest unclaimed, which
    is what the shapes layer draws - a feed where every shape belongs to a route
    exercises only half the map.
    """
    routes = shapes if routes is None else routes
    directory.mkdir(parents=True, exist_ok=True)

    def write(name: str, header: str, rows) -> None:
        (directory / name).write_text(header + "\n" + "\n".join(rows) + "\n", encoding="utf-8")

    write("agency.txt", "agency_id,agency_name,agency_url,agency_timezone", ["A1,Test,https://example.org,UTC"])
    write("calendar.txt", "service_id,monday,start_date,end_date", ["S1,1,20200101,20301231"])
    write(
        "stops.txt",
        "stop_id,stop_name,stop_lat,stop_lon",
        [f"ST{i},Stop {i},{45 + i % 1000 / 10000:.5f},{-73 + i % 997 / 10000:.5f}" for i in range(stops)],
    )
    write(
        "routes.txt",
        "route_id,agency_id,route_short_name,route_long_name,route_type,route_color",
        [f"R{i},A1,{i},Route {i},3,FF0000" for i in range(routes)],
    )
    write(
        "trips.txt",
        "route_id,service_id,trip_id,shape_id",
        [f"R{i},S1,T{i},SH{i}" for i in range(routes)],
    )
    write(
        "shapes.txt",
        "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence",
        [
            f"SH{s},{45 + (s * points_per_shape + p) % 10000 / 10000:.5f}," f"{-73 + (s + p) % 10000 / 10000:.5f},{p}"
            for s in range(shapes)
            for p in range(points_per_shape)
        ],
    )
    write(
        "stop_times.txt",
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
        [f"T{i},08:00:00,08:00:00,ST{i % max(stops, 1)},1" for i in range(routes)],
    )
    return directory
