"""Where a run keeps the files it writes.

Every scratch directory the tool produces lands under one root, so a user can
see what is on disk and delete it deliberately. `--workdir` says where that root
is; without one it is a directory under the platform cache, and either way it is
kept. Feeds therefore outlive the run that loaded them, which is the whole point
of converting them: the load dialog offers what is already there on the next
start, and reopening costs no download, unzip or conversion.

Retention is what stops that growing without end - `keep` feeds survive, oldest
out first - so the kept directory has a ceiling rather than a lifetime. Only an
export takes a workspace of its own, through `ephemeral`, because an export
writes its answer somewhere else and should leave nothing behind.

A feed occupies a *slot*, named from the label it was loaded under, so loading
the same URL twice reuses one directory rather than doubling the disk:

    <root>/feeds/<slug>/source/     the archive as it arrived
                       /extract/    the CSVs, dropped once converted
                       /parquet/    what the queries actually read
                       /feed.json   what this slot holds

`parquet/` is the shape `GtfsFeed.export_parquet` writes, so reopening a slot is
`GtfsFeed(slot.parquet_dir)` and takes no special path through the loader.

A persistent workspace can also name one of its slots as the feed to open at
startup, in `<root>/startup.json`. That is the stored form of `--reopen ID`, set
from the options menu rather than the command line, and it is what makes a
workdir something you return to rather than something you point at again.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

APP_DIR = "gtfs-garage"
# The default root under the cache directory, shared by every run that does
# not name its own with --workdir.
DEFAULT_DIR = "workdir"
FEEDS_DIR = "feeds"
RUNS_DIR = "runs"
DUCKDB_DIR = "duckdb"
RECORD = "feed.json"
STARTUP = "startup.json"

# How many feeds a workspace keeps. 1 means the previous feed goes as soon as a
# new one lands; 0 means nothing is ever evicted.
DEFAULT_KEEP = 3

# A run directory whose process is gone is rubbish. Where liveness cannot be
# established - a recycled pid, a platform where the check means less - age is
# the fallback, generous enough that a long-running server is never swept.
STALE_RUN_SECONDS = 24 * 60 * 60

_SLUG_UNSAFE = re.compile(r"[^a-zA-Z0-9]+")


def cache_root() -> Path:
    """The platform's cache directory, where an unasked-for workdir belongs."""
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / APP_DIR
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / APP_DIR / "Cache"
    base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(base) / APP_DIR


def slug_for(label: str) -> str:
    """A directory name for a feed, derived from the label alone.

    Hash-suffixed because two feeds can present the same readable name - two
    `gtfs.zip` from different cities - and sharing a slot would have one
    overwrite the other. The readable half is the label's *end*: a path or URL
    is mostly prefix, so its front names a home directory and its end names the
    feed.
    """
    readable = _SLUG_UNSAFE.sub("-", label).strip("-").lower()[-40:].strip("-") or "feed"
    digest = hashlib.sha256(label.encode("utf-8")).hexdigest()[:8]
    return f"{readable}-{digest}"


def directory_bytes(path: Path) -> int:
    """What a directory tree occupies, ignoring what cannot be read."""
    total = 0
    if not path.exists():
        return 0
    for entry in path.rglob("*"):
        try:
            if entry.is_file() and not entry.is_symlink():
                total += entry.stat().st_size
        except OSError:
            continue
    return total


@dataclass(frozen=True)
class FeedSlot:
    """One feed's place in the workspace."""

    id: str
    root: Path

    @property
    def source_dir(self) -> Path:
        return self.root / "source"

    @property
    def extract_dir(self) -> Path:
        return self.root / "extract"

    @property
    def parquet_dir(self) -> Path:
        return self.root / "parquet"

    @property
    def record_path(self) -> Path:
        return self.root / RECORD

    def prepare(self) -> FeedSlot:
        """Create the directories, replacing whatever the slot held before.

        A reused slot's contents describe the previous fetch, so a feed that
        lost a file between the two would otherwise appear to still have it.
        """
        shutil.rmtree(self.root, ignore_errors=True)
        for directory in (self.source_dir, self.extract_dir, self.parquet_dir):
            directory.mkdir(parents=True, exist_ok=True)
        return self


@dataclass(frozen=True)
class WorkspaceEntry:
    """What a slot holds, as the interface lists it."""

    id: str
    label: str
    kind: str
    loaded_at: str
    bytes: int
    tables: int
    # False when the slot holds no Parquet - a feed opened with --no-parquet, or
    # a load that was interrupted. There is nothing to reopen it from.
    reloadable: bool


class Workspace:
    def __init__(self, root: Path, persistent: bool, keep: int = DEFAULT_KEEP) -> None:
        self.path = Path(root).expanduser().resolve()
        self.persistent = persistent
        self.keep = max(0, keep)
        self.feeds_dir = self.path / FEEDS_DIR
        self.duckdb_dir = self.path / DUCKDB_DIR
        self.startup_path = self.path / STARTUP
        self.feeds_dir.mkdir(parents=True, exist_ok=True)
        self.duckdb_dir.mkdir(parents=True, exist_ok=True)

    @classmethod
    def resolve(cls, workdir: str | None = None, keep: int | None = None) -> Workspace:
        """Build the workspace a server should use. Kept, either way.

        A named directory is used as given; without one, the shared directory
        under the platform cache, so that a plain run still finds the feeds its
        last run converted instead of starting from nothing every time.
        """
        wanted = DEFAULT_KEEP if keep is None else keep
        if workdir:
            return cls(Path(workdir), persistent=True, keep=wanted)

        # Versions before the default was kept wrote a directory per run under
        # `runs/`. Nothing writes there now, so this is the one chance to clear
        # what they left, and it is the same sweep they ran themselves.
        runs = cache_root() / RUNS_DIR
        if runs.is_dir():
            sweep_stale_runs(runs)
        return cls(cache_root() / DEFAULT_DIR, persistent=True, keep=wanted)

    @classmethod
    def ephemeral(cls, keep: int | None = None) -> Workspace:
        """A workspace of this run's own, removed by `close`.

        For work that produces its result somewhere else and should leave
        nothing behind - an export - and so must not touch, evict from, or be
        evicted by the directory a server is keeping.
        """
        runs = cache_root() / RUNS_DIR
        runs.mkdir(parents=True, exist_ok=True)
        sweep_stale_runs(runs)
        # A token as well as the pid: one process can hold more than one
        # workspace - the test suite does - and they must not share a root.
        return cls(
            runs / f"{os.getpid()}-{uuid.uuid4().hex[:8]}",
            persistent=False,
            keep=DEFAULT_KEEP if keep is None else keep,
        )

    # ----------------------------------------------------------------- slots

    def slot(self, label: str) -> FeedSlot:
        """A fresh, empty slot for a feed about to be loaded."""
        slot_id = slug_for(label)
        return FeedSlot(slot_id, self.feeds_dir / slot_id).prepare()

    def existing(self, slot_id: str) -> FeedSlot | None:
        """A slot already on disk, or None. Never accepts a traversing id."""
        if slot_id != Path(slot_id).name or slot_id in ("", ".", ".."):
            return None
        root = self.feeds_dir / slot_id
        return FeedSlot(slot_id, root) if root.is_dir() else None

    def record(self, slot: FeedSlot, label: str, kind: str, tables: int) -> None:
        """Say what the slot holds, so a later run can list it without opening it."""
        slot.record_path.write_text(
            json.dumps(
                {
                    "id": slot.id,
                    "label": label,
                    "kind": kind,
                    # Microseconds, not seconds: retention sorts on this, and
                    # two feeds loaded in the same second would otherwise have
                    # no order at all and the wrong one would be evicted.
                    "loaded_at": datetime.now(timezone.utc).isoformat(timespec="microseconds"),
                    "tables": tables,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    # --------------------------------------------------------------- reading

    def entries(self) -> list[WorkspaceEntry]:
        """Every slot that carries a record, most recently loaded first.

        A directory without a readable record is an interrupted load, and
        reporting it as a feed would offer a reload that cannot work.
        """
        found = []
        for directory in sorted(self.feeds_dir.glob("*")):
            if not directory.is_dir():
                continue
            try:
                data = json.loads((directory / RECORD).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            found.append(
                WorkspaceEntry(
                    id=directory.name,
                    label=str(data.get("label") or directory.name),
                    kind=str(data.get("kind") or "path"),
                    loaded_at=str(data.get("loaded_at") or ""),
                    bytes=directory_bytes(directory),
                    tables=int(data.get("tables") or 0),
                    reloadable=any((directory / "parquet").glob("*.parquet")),
                )
            )
        return sorted(found, key=lambda entry: entry.loaded_at, reverse=True)

    def total_bytes(self) -> int:
        return directory_bytes(self.path)

    def latest(self) -> WorkspaceEntry | None:
        """The most recently loaded feed that can actually be reopened.

        What `--reopen` with no id means. A slot with no Parquet is skipped
        rather than returned and then refused.
        """
        return next((entry for entry in self.entries() if entry.reloadable), None)

    # --------------------------------------------------------------- startup

    def startup_feed(self) -> str | None:
        """The slot a new server should open, or None.

        Checked against what is actually on disk rather than returned as
        written: the named feed can have been deleted or evicted since someone
        chose it, and a workdir that pointed at a slot that is no longer there
        would fail to start over a preference.
        """
        try:
            data = json.loads(self.startup_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        wanted = data.get("feed") if isinstance(data, dict) else None
        if not isinstance(wanted, str) or not wanted:
            return None
        return wanted if any(e.id == wanted and e.reloadable for e in self.entries()) else None

    def set_startup_feed(self, slot_id: str | None) -> None:
        """Name the feed to open at startup, or clear the choice with None."""
        if slot_id is None:
            self.startup_path.unlink(missing_ok=True)
            return
        self.startup_path.write_text(json.dumps({"feed": slot_id}, indent=2) + "\n", encoding="utf-8")

    # --------------------------------------------------------------- removal

    def remove(self, slot_id: str) -> int:
        """Delete one slot and report what it freed."""
        slot = self.existing(slot_id)
        if slot is None:
            return 0
        freed = directory_bytes(slot.root)
        shutil.rmtree(slot.root, ignore_errors=True)
        return freed

    def clear(self, protected: set[str] | None = None) -> int:
        """Delete every slot that is not in use, and report what that freed."""
        held = protected or set()
        freed = 0
        for entry in self.entries():
            if entry.id not in held:
                freed += self.remove(entry.id)
        return freed

    def enforce_retention(self, protected: set[str] | None = None) -> list[str]:
        """Drop the oldest slots past the limit, and say which went.

        `protected` names the slots of feeds that are still open. Deleting a
        Parquet file out from under a running query is the one thing this must
        not do, so they are never candidates however the dates sort.
        """
        if self.keep <= 0:
            return []
        held = protected or set()
        survivors = 0
        removed = []
        for entry in self.entries():
            survivors += 1
            if survivors > self.keep and entry.id not in held:
                self.remove(entry.id)
                removed.append(entry.id)
        return removed

    def close(self) -> None:
        """Give up what this run created, unless the workspace is a kept one."""
        if not self.persistent:
            shutil.rmtree(self.path, ignore_errors=True)


def sweep_stale_runs(runs: Path) -> list[str]:
    """Remove run directories left behind by processes that are gone.

    Only ever called against the cache directory's own `runs/`, never a
    `--workdir`: a heuristic about process liveness has no business deleting
    from a directory someone named.
    """
    removed = []
    for directory in runs.glob("*"):
        if not directory.is_dir() or not _is_stale(directory):
            continue
        shutil.rmtree(directory, ignore_errors=True)
        removed.append(directory.name)
    return removed


def _is_stale(directory: Path) -> bool:
    pid_part = directory.name.split("-", 1)[0]
    if _pid_check_is_meaningful() and pid_part.isdigit():
        # The direct answer, where the platform gives one.
        return not _process_is_alive(int(pid_part))
    # Otherwise age is all there is, and it is deliberately generous: sweeping
    # a directory a running server is using would delete the feed it is serving.
    try:
        return time.time() - directory.stat().st_mtime > STALE_RUN_SECONDS
    except OSError:
        return False


def _pid_check_is_meaningful() -> bool:
    """`os.kill(pid, 0)` answers reliably on POSIX and not on Windows."""
    return sys.platform != "win32"


def _process_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Someone else's process, which is still a process.
        return True
    except OSError:
        return False
    return True
