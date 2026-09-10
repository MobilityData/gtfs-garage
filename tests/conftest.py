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
