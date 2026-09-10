"""Holds the feed the server is currently serving.

The tool shows one feed at a time, so this is deliberately a single slot rather
than a session store. It lives on the FastAPI app instance instead of in a
module-level dict, so tests can build an isolated app and so two servers in one
process do not share a feed.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from gtfs_garage.core.feed import GtfsFeed


class NoFeedLoadedError(RuntimeError):
    """A request needs a feed but none has been loaded yet."""


class FeedRegistry:
    def __init__(self) -> None:
        self._feed: GtfsFeed | None = None
        self._source: str | None = None
        self._upload_dirs: list[Path] = []

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

    def load(self, source: str) -> GtfsFeed:
        """Replace the current feed.

        The new feed is opened before the old one is closed, so a load that
        fails leaves the previously working feed in place.
        """
        feed = GtfsFeed(source)
        previous = self._feed
        self._feed, self._source = feed, source
        if previous is not None:
            previous.close()
        return feed

    def store_upload(self, filename: str, stream) -> Path:
        """Persist an uploaded feed to a temporary directory and return its path."""
        directory = Path(tempfile.mkdtemp(prefix="gtfs-garage-upload-"))
        self._upload_dirs.append(directory)
        destination = directory / filename
        with destination.open("wb") as out:
            shutil.copyfileobj(stream, out)
        return destination

    def close(self) -> None:
        if self._feed is not None:
            self._feed.close()
            self._feed, self._source = None, None
        for directory in self._upload_dirs:
            shutil.rmtree(directory, ignore_errors=True)
        self._upload_dirs.clear()
