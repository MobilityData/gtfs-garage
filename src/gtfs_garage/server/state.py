"""Holds the feed the server is currently serving.

The tool shows one feed at a time, so this is deliberately a single slot rather
than a session store. It lives on the FastAPI app instance instead of in a
module-level dict, so tests can build an isolated app and so two servers in one
process do not share a feed.
"""

from __future__ import annotations

import shutil
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from gtfs_garage import __version__
from gtfs_garage.core.feed import FeedStats, GtfsFeed, GtfsLoadError

DOWNLOAD_TIMEOUT_SECONDS = 60
# Generous enough for any real feed, low enough that a wrong URL cannot fill the
# disk before the mistake is noticed.
MAX_DOWNLOAD_BYTES = 2 * 1024**3
USER_AGENT = f"gtfs-garage/{__version__} (+https://github.com/MobilityData/gtfs-garage)"


def _elapsed_ms(since: float) -> float:
    return (time.perf_counter() - since) * 1000


class NoFeedLoadedError(RuntimeError):
    """A request needs a feed but none has been loaded yet."""


@dataclass
class AcquireStats:
    """Getting the feed's bytes onto local disk, before it is opened.

    A feed given as a local path skips this entirely - there is nothing to
    fetch or copy - which is why `FeedRecord.acquire` is optional.
    """

    kind: str  # upload | folder | download
    bytes: int
    ms: float


@dataclass
class FeedRecord:
    """How the currently loaded feed was obtained and what it cost."""

    kind: str  # path | upload | folder | download
    feed_stats: FeedStats
    acquire: AcquireStats | None = None


class FeedRegistry:
    def __init__(self) -> None:
        self._feed: GtfsFeed | None = None
        self._source: str | None = None
        self._upload_dirs: list[Path] = []
        # Set by the store_* methods, consumed by the next load().
        self._acquire: AcquireStats | None = None
        self.last_load: FeedRecord | None = None

    @property
    def source(self) -> str:
        if self._source is None:
            raise NoFeedLoadedError()
        return self._source

    @property
    def is_loaded(self) -> bool:
        return self._feed is not None

    def current(self) -> GtfsFeed:
        if self._feed is None:
            raise NoFeedLoadedError()
        return self._feed

    def load(self, source: str, label: str | None = None) -> GtfsFeed:
        """Replace the current feed.

        The new feed is opened before the old one is closed, so a load that
        fails leaves the previously working feed in place.

        `label` is what the interface displays. Uploads and downloads live in
        temporary directories, so they report where they came from instead of
        the scratch path they landed in.
        """
        feed = GtfsFeed(source)
        self.last_load = FeedRecord(
            kind=self._acquire.kind if self._acquire else "path",
            feed_stats=feed.stats,
            acquire=self._acquire,
        )
        self._acquire = None
        previous = self._feed
        self._feed, self._source = feed, label or source
        if previous is not None:
            previous.close()
        return feed

    def store_upload(self, filename: str, stream) -> Path:
        """Persist an uploaded feed to a temporary directory and return its path."""
        destination = self._scratch_path("gtfs-garage-upload-", filename)
        started = time.perf_counter()
        with destination.open("wb") as out:
            shutil.copyfileobj(stream, out)
        self._acquire = AcquireStats("upload", destination.stat().st_size, _elapsed_ms(started))
        return destination

    def store_upload_folder(self, files: Iterable[tuple[str, object]]) -> Path:
        """Reassemble an uploaded folder and return the directory holding it.

        A browser sends a chosen folder as its individual files, so they are
        written back into one directory for the loader to read as a feed. Names
        are flattened to their basename: GTFS files sit at one level, and a
        relative path from the browser should not steer where anything lands.
        """
        directory = Path(tempfile.mkdtemp(prefix="gtfs-garage-folder-"))
        self._upload_dirs.append(directory)

        started = time.perf_counter()
        written = 0
        written_bytes = 0
        for filename, stream in files:
            name = Path(filename).name
            if not name or name.startswith("."):
                continue
            destination = directory / name
            with destination.open("wb") as out:
                shutil.copyfileobj(stream, out)
            written += 1
            written_bytes += destination.stat().st_size

        if written == 0:
            raise GtfsLoadError("That folder contained no files to read.")
        self._acquire = AcquireStats("folder", written_bytes, _elapsed_ms(started))
        return directory

    def store_download(self, url: str) -> Path:
        """Fetch a feed over HTTP into a temporary directory and return its path."""
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("http", "https"):
            raise GtfsLoadError(f"Only http and https URLs can be downloaded, got '{parsed.scheme or url}'")

        filename = Path(urllib.parse.unquote(parsed.path)).name or "feed.zip"
        destination = self._scratch_path("gtfs-garage-download-", filename)

        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
                written = 0
                with destination.open("wb") as out:
                    while chunk := response.read(64 * 1024):
                        written += len(chunk)
                        if written > MAX_DOWNLOAD_BYTES:
                            raise GtfsLoadError(
                                f"Feed at {url} is larger than "
                                f"{MAX_DOWNLOAD_BYTES // 1024**3} GiB; download it manually instead"
                            )
                        out.write(chunk)
        except GtfsLoadError:
            raise
        except urllib.error.HTTPError as exc:
            raise GtfsLoadError(f"{url} returned {exc.code} {exc.reason}") from exc
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise GtfsLoadError(f"Could not download {url}: {exc}") from exc

        self._acquire = AcquireStats("download", written, _elapsed_ms(started))
        return destination

    def _scratch_path(self, prefix: str, filename: str) -> Path:
        directory = Path(tempfile.mkdtemp(prefix=prefix))
        self._upload_dirs.append(directory)
        # Guard against a name from the URL or upload escaping the directory.
        return directory / Path(filename).name

    def close(self) -> None:
        if self._feed is not None:
            self._feed.close()
            self._feed, self._source = None, None
            self.last_load = None
        for directory in self._upload_dirs:
            shutil.rmtree(directory, ignore_errors=True)
        self._upload_dirs.clear()
