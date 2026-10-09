"""Holds the feed the server is currently serving.

The tool shows one feed at a time, so this is deliberately a single slot rather
than a session store. It lives on the FastAPI app instance instead of in a
module-level dict, so tests can build an isolated app and so two servers in one
process do not share a feed.
"""

from __future__ import annotations

import shutil
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from gtfs_garage import __version__
from gtfs_garage.core.feed import FeedStats, GtfsFeed, GtfsLoadError
from gtfs_garage.core.workspace import FeedSlot, Workspace

DOWNLOAD_TIMEOUT_SECONDS = 60
# Generous enough for any real feed, low enough that a wrong URL cannot fill the
# disk before the mistake is noticed.
MAX_DOWNLOAD_BYTES = 2 * 1024**3
USER_AGENT = f"gtfs-garage/{__version__} (+https://github.com/MobilityData/gtfs-garage)"

# Phases a load reports while it runs, in the order they happen.
# A load starts here because nothing yet knows whether the feed will be
# downloaded, uploaded or simply opened from a path.
PHASE_START = "start"
PHASE_DOWNLOAD = "download"
PHASE_UPLOAD = "upload"
PHASE_SUMMARISE = "summarise"
PHASE_DONE = "done"


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
    # The workspace slot holding this feed's files, so the interface can point
    # at the right row and the registry knows what it must not delete.
    slot_id: str | None = None


@dataclass(frozen=True)
class Serving:
    """One consistent view of what is being served.

    The feed, where it came from and what it cost to load are three pieces of
    registry state that a load replaces separately. Read one at a time, a
    response can pair one feed's tables with another load's metrics; captured
    together under the lock, they cannot disagree.
    """

    feed: GtfsFeed
    source: str
    load: FeedRecord


@dataclass
class LoadProgress:
    """Where a running load has got to.

    Polled by the interface while the load request is still in flight, which is
    only answerable because the load runs in a worker thread rather than on the
    event loop.
    """

    phase: str = PHASE_DONE
    done: int = 0
    # 0 when the total is not knowable, e.g. a download with no Content-Length.
    total: int = 0
    detail: str = ""
    # True between the start of a load and its success or failure.
    running: bool = False


class FeedRegistry:
    def __init__(self, optimise: bool = True, workspace: Workspace | None = None) -> None:
        self._feed: GtfsFeed | None = None
        self._source: str | None = None
        # Where every file this server writes goes. Defaulted rather than
        # required, so `FeedRegistry()` still means something on its own.
        self.workspace = workspace if workspace is not None else Workspace.resolve()
        # Set by the store_* methods, consumed by the next load().
        self._acquire: AcquireStats | None = None
        self._pending_slot: FeedSlot | None = None
        self.last_load: FeedRecord | None = None
        self.optimise = optimise
        self.progress = LoadProgress()
        # Guards the feed slot and the reader count below. Requests genuinely
        # run concurrently now that loading happens off the event loop.
        self._lock = threading.Lock()
        # How many requests are reading the current feed right now. A replaced
        # feed cannot be closed until its own readers have finished, or their
        # cursors would be pulled out from under them mid-query.
        self._readers = 0
        self._retired: list[tuple[GtfsFeed, int]] = []

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

    @contextmanager
    def serving(self) -> Iterator[Serving]:
        """Borrow the current feed, and what produced it, for one request.

        Holding this keeps the feed alive even if a load replaces it midway.
        Streaming responses must hold it for the whole stream, not just while
        the handler runs, because the cursor is still in use after the handler
        has returned.
        """
        with self._lock:
            feed = self._feed
            if feed is None or self._source is None or self.last_load is None:
                raise NoFeedLoadedError()
            served = Serving(feed=feed, source=self._source, load=self.last_load)
            self._readers += 1
        try:
            yield served
        finally:
            with self._lock:
                self._readers -= 1
                self._release_retired(feed)

    @contextmanager
    def reading(self) -> Iterator[GtfsFeed]:
        """Borrow just the feed, for the handlers that need nothing else."""
        with self.serving() as served:
            yield served.feed

    def _release_retired(self, feed: GtfsFeed) -> None:
        """Close a replaced feed once the last request reading it is done."""
        if feed is self._feed:
            return
        remaining = []
        for retired, readers in self._retired:
            if retired is feed:
                readers -= 1
                if readers <= 0:
                    retired.close()
                    continue
            remaining.append((retired, readers))
        self._retired = remaining

    def _set_progress(self, phase: str, done: int = 0, total: int = 0, detail: str = "") -> None:
        self.progress = LoadProgress(phase=phase, done=done, total=total, detail=detail, running=True)

    def load(
        self,
        source: str,
        label: str | None = None,
        slot: FeedSlot | None = None,
        kind: str | None = None,
    ) -> GtfsFeed:
        """Replace the current feed.

        The new feed is opened before the old one is closed, so a load that
        fails leaves the previously working feed in place. The old one is only
        actually closed once nothing is still reading it.

        `label` is what the interface displays. Uploads and downloads live in
        the workspace, so they report where they came from instead of the
        directory they landed in.

        `slot` is where the feed's files go. The acquiring step has usually
        already claimed one - it had to, to have somewhere to write - and a feed
        opened straight from a path claims one here.

        `kind` overrides how the feed is said to have been obtained. Only
        `reopen` passes it, so that a downloaded feed read back from the workdir
        is still listed as a download rather than as the local path it now is.
        """
        shown = label or source
        slot = slot or self._pending_slot or self.workspace.slot(shown)
        self._pending_slot = None
        kind = kind or (self._acquire.kind if self._acquire else "path")

        feed = GtfsFeed(
            source,
            optimise=self.optimise,
            on_progress=self._set_progress,
            slot=slot,
            temp_directory=self.workspace.duckdb_dir,
        )
        self._set_progress(PHASE_SUMMARISE)
        self.workspace.record(slot, shown, kind, len(feed.tables))

        with self._lock:
            self.last_load = FeedRecord(
                kind=kind,
                feed_stats=feed.stats,
                acquire=self._acquire,
                slot_id=slot.id,
            )
            self._acquire = None
            previous, readers = self._feed, self._readers
            self._feed, self._source = feed, shown
            self._readers = 0
            if previous is not None:
                if readers > 0:
                    self._retired.append((previous, readers))
                else:
                    previous.close()
        # After the replacement, so the slot of the feed now being served is
        # counted as the newest and the oldest is what goes.
        self.workspace.enforce_retention(self.held_slots())
        return feed

    def reopen(self, slot_id: str) -> GtfsFeed:
        """Serve a feed already in the workspace, from the Parquet it became.

        No download, no unzip and no conversion: `GtfsFeed` opens a directory of
        Parquet directly, which is the whole reason the workspace stores feeds
        in that shape.
        """
        slot = self.workspace.existing(slot_id)
        entry = next((e for e in self.workspace.entries() if e.id == slot_id), None)
        if slot is None or entry is None or not entry.reloadable:
            raise GtfsLoadError("That feed is no longer in the workdir.")
        self._acquire = None
        return self.load(str(slot.parquet_dir), entry.label, slot=slot, kind=entry.kind)

    def held_slots(self) -> set[str]:
        """Slots whose files are open, and so must not be deleted."""
        with self._lock:
            feeds = [self._feed, *(retired for retired, _ in self._retired)]
        return {feed.slot.id for feed in feeds if feed is not None and feed.slot is not None}

    def begin_load(self) -> None:
        self.progress = LoadProgress(phase=PHASE_START, running=True)

    def finish_load(self) -> None:
        self.progress = LoadProgress(phase=PHASE_DONE, running=False)

    def store_upload(self, filename: str, stream) -> Path:
        """Persist an uploaded feed into its workspace slot and return its path."""
        destination = self._claim(filename) / Path(filename).name
        started = time.perf_counter()
        self._set_progress(PHASE_UPLOAD, detail=filename)
        with destination.open("wb") as out:
            shutil.copyfileobj(stream, out)
        self._acquire = AcquireStats("upload", destination.stat().st_size, _elapsed_ms(started))
        return destination

    def store_upload_folder(self, files: Iterable[tuple[str, object]], name: str = "chosen folder") -> Path:
        """Reassemble an uploaded folder and return the directory holding it.

        A browser sends a chosen folder as its individual files, so they are
        written back into one directory for the loader to read as a feed. Names
        are flattened to their basename: GTFS files sit at one level, and a
        relative path from the browser should not steer where anything lands.
        """
        directory = self._claim(name)

        started = time.perf_counter()
        written = 0
        written_bytes = 0
        self._set_progress(PHASE_UPLOAD)
        for filename, stream in files:
            member = Path(filename).name
            if not member or member.startswith("."):
                continue
            destination = directory / member
            with destination.open("wb") as out:
                shutil.copyfileobj(stream, out)
            written += 1
            written_bytes += destination.stat().st_size
            self._set_progress(PHASE_UPLOAD, written, 0, member)

        if written == 0:
            raise GtfsLoadError("That folder contained no files to read.")
        self._acquire = AcquireStats("folder", written_bytes, _elapsed_ms(started))
        return directory

    def store_download(self, url: str) -> Path:
        """Fetch a feed over HTTP into its workspace slot and return its path."""
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("http", "https"):
            raise GtfsLoadError(f"Only http and https URLs can be downloaded, got '{parsed.scheme or url}'")

        filename = Path(urllib.parse.unquote(parsed.path)).name or "feed.zip"
        # `.name` again on the way in: a URL path can walk upwards, and the
        # slot is not somewhere a crafted link gets to choose a destination in.
        destination = self._claim(url) / Path(filename).name

        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
                # Absent on a chunked response, in which case progress reports
                # bytes so far against an unknown total rather than guessing.
                expected = int(response.headers.get("Content-Length") or 0)
                written = 0
                with destination.open("wb") as out:
                    while chunk := response.read(64 * 1024):
                        written += len(chunk)
                        self._set_progress(PHASE_DOWNLOAD, written, expected, filename)
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

    def _claim(self, label: str) -> Path:
        """Take the slot this feed will occupy, and return where its source goes.

        Claimed here rather than at `load` because the bytes have to land
        somewhere before there is a feed to open, and that somewhere should be
        the slot the feed will end up in rather than a directory of its own.
        """
        self._pending_slot = self.workspace.slot(label)
        return self._pending_slot.source_dir

    def close(self) -> None:
        for retired, _ in self._retired:
            retired.close()
        self._retired.clear()
        if self._feed is not None:
            self._feed.close()
            self._feed, self._source = None, None
            self.last_load = None
        # Only an ephemeral workspace goes; a --workdir is the user's, and
        # keeping it across runs is the reason they named one.
        self.workspace.close()
