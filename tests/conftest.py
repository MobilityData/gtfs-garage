import shutil
import sys
from pathlib import Path

import pytest

from gtfs_garage.core import workspace as workspace_module
from gtfs_garage.core.feed import GtfsFeed

# `tests/` is not a package, so a sibling module is not importable without this.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from feeds import write_feed  # noqa: E402

FIXTURE_DIR = Path(__file__).parent / "data" / "mini-gtfs"

# A feed with enough calendar to have something to say: three weekly services
# plus a night one, exceptions in both directions, two agencies, a route that
# runs past midnight and a route with a short working.
EXPLORE_DIR = Path(__file__).parent / "data" / "explore-gtfs"

# A demand-responsive feed, which breaks most assumptions a fixed-schedule one
# lets you make: routes named only by their long name, an empty stops.txt, trips
# that call at zones and groups of zones, booking windows instead of departure
# times, and a loop that passes the same zone twice.
#
# Distinct from `data/flex-gtfs`, which exists to exercise reading
# locations.geojson and is owned by tests/test_locations_geojson.py.
DEMAND_DIR = Path(__file__).parent / "data" / "demand-gtfs"


@pytest.fixture(autouse=True)
def cache_home(tmp_path_factory, monkeypatch) -> Path:
    """Keep a run's workdir out of the real cache directory.

    A workspace with no `--workdir` takes a directory under the platform cache,
    so the suite would otherwise write into - and sweep - the developer's own.

    `cache_root` is replaced rather than `$HOME` or `$XDG_CACHE_HOME`: the cache
    directory is shared, and moving it moves every tool that reads it. Playwright
    keeps its browsers under the same root, so repointing the environment made
    the browser guard fail to find a Chromium that was installed.
    """
    root = tmp_path_factory.mktemp("cache") / "gtfs-garage"
    monkeypatch.setattr(workspace_module, "cache_root", lambda: root)
    return root


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


@pytest.fixture(scope="session")
def explore_feed_dir() -> Path:
    """The richer fixture feed, as an extracted folder."""
    return EXPLORE_DIR


@pytest.fixture()
def explore_feed(explore_feed_dir: Path):
    """A feed with calendars, exceptions, patterns and times past midnight."""
    loaded = GtfsFeed(str(explore_feed_dir), optimise=False)
    yield loaded
    loaded.close()


@pytest.fixture(scope="session")
def demand_feed_dir() -> Path:
    """The demand-responsive fixture feed, as an extracted folder."""
    return DEMAND_DIR


@pytest.fixture()
def demand_feed(demand_feed_dir: Path):
    """A flex feed: zones, booking windows, no short names, an empty stops.txt."""
    loaded = GtfsFeed(str(demand_feed_dir), optimise=False)
    yield loaded
    loaded.close()


@pytest.fixture()
def generated_feed(tmp_path: Path):
    """Build a feed of a given size on demand."""

    def build(stops: int = 200, shapes: int = 50, points_per_shape: int = 10, routes: int | None = None) -> Path:
        name = f"feed-{stops}-{shapes}-{points_per_shape}-{routes}"
        return write_feed(tmp_path / name, stops, shapes, points_per_shape, routes)

    return build
