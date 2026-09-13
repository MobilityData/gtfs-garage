import shutil
from pathlib import Path

import pytest

from gtfs_garage.core.feed import GtfsFeed

FIXTURE_DIR = Path(__file__).parent / "data" / "mini-gtfs"


@pytest.fixture(scope="session")
def feed_dir() -> Path:
    """The fixture feed as an extracted folder."""
    return FIXTURE_DIR


@pytest.fixture()
def feed_zip(tmp_path: Path) -> Path:
    """The fixture feed zipped, with the .txt files at the archive root."""
    archive = shutil.make_archive(str(tmp_path / "feed"), "zip", root_dir=FIXTURE_DIR)
    return Path(archive)


@pytest.fixture()
def nested_feed_zip(tmp_path: Path) -> Path:
    """A zip that wraps the .txt files in a subfolder, as GitHub exports do."""
    staging = tmp_path / "staging" / "Some-Feed-master"
    staging.mkdir(parents=True)
    for source in FIXTURE_DIR.glob("*.txt"):
        shutil.copy(source, staging / source.name)
    archive = shutil.make_archive(str(tmp_path / "nested"), "zip", root_dir=staging.parent)
    return Path(archive)


@pytest.fixture()
def feed(feed_dir: Path):
    loaded = GtfsFeed(str(feed_dir))
    yield loaded
    loaded.close()


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


@pytest.fixture()
def generated_feed(tmp_path: Path):
    """Build a feed of a given size on demand."""

    def build(stops: int = 200, shapes: int = 50, points_per_shape: int = 10, routes: int | None = None) -> Path:
        name = f"feed-{stops}-{shapes}-{points_per_shape}-{routes}"
        return write_feed(tmp_path / name, stops, shapes, points_per_shape, routes)

    return build
