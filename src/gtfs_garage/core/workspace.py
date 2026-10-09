"""Where a run keeps the files it writes.

Every scratch directory the tool produces - an extracted zip, the Parquet a feed
is converted to, an uploaded or downloaded archive - lands under one root, so a
user can see what is on disk, reopen a feed without fetching it again, and
delete the lot deliberately rather than hunting through `$TMPDIR`.

Two modes, one layout:

- `--workdir DIR` is **persistent**. Feeds survive the process, so the next run
  lists them and can reopen one from its Parquet in milliseconds.
- With no flag the root is a per-run directory under the platform cache dir,
  **ephemeral**: it is removed when the server stops, and a run left behind by a
  crash is swept the next time one starts. The path is still a stable, printable
  one rather than a random `mkdtemp` name, which is the actual complaint - not
  that temporary files exist, but that nobody could say where.

A feed occupies a *slot*, named from the label it was loaded under, so loading
the same URL twice reuses one directory instead of doubling the disk:

    <root>/feeds/<slug>/source/     the archive as it arrived
                       /extract/    the CSVs, dropped once converted
                       /parquet/    what the queries actually read
                       /feed.json   what this slot holds

`parquet/` is deliberately the same shape `GtfsFeed.export_parquet` writes, so
reopening a slot is `GtfsFeed(slot.parquet_dir)` and nothing special happens.
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
FEEDS_DIR = "feeds"
RUNS_DIR = "runs"
DUCKDB_DIR = "duckdb"
RECORD = "feed.json"

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

    Readable at the front so a listing of the workdir means something, and
    hash-suffixed at the back because two different feeds can present the same
    readable name - two `gtfs.zip` from different cities, say - and sharing a
    slot would have one silently overwrite the other.

    The readable part is the *end* of the label, not the start: a feed is
    identified by its filename, and an absolute path or a URL is mostly prefix.
    Keeping the front of `/Users/sam/work/transit/2026/montreal.zip` names the
    home directory; keeping the end names the feed.
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

        A slot is reused when the same feed is loaded again, and the previous
        contents describe the previous fetch - a feed that lost a file between
        the two would otherwise appear to still have it.
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
        self.feeds_dir.mkdir(parents=True, exist_ok=True)
        self.duckdb_dir.mkdir(parents=True, exist_ok=True)

    @classmethod
    def resolve(cls, workdir: str | None = None, keep: int | None = None) -> Workspace:
        """Build the workspace a run should use.

        A named directory is persistent; the absence of one produces a run of
        its own under the cache directory, and sweeps the runs that no longer
        have a process behind them.
        """
        wanted = DEFAULT_KEEP if keep is None else keep
        if workdir:
            return cls(Path(workdir), persistent=True, keep=wanted)

        runs = cache_root() / RUNS_DIR
        runs.mkdir(parents=True, exist_ok=True)
        sweep_stale_runs(runs)
        # A token as well as the pid: one process can hold more than one
        # workspace - the test suite does - and they must not share a root.
        return cls(runs / f"{os.getpid()}-{uuid.uuid4().hex[:8]}", persistent=False, keep=wanted)

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

        A directory without a readable record is skipped rather than guessed at:
        it is a load that was interrupted before it finished, and reporting it
        as a feed would offer a reload that cannot work.
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

        `protected` names the slots of feeds that are still open - the one being
        served, and any a request is still reading. Those are never candidates
        however the dates sort, because deleting a Parquet file out from under a
        running query is the one thing this must not do.
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
        """Give up what this run created, unless the user asked to keep it."""
        if not self.persistent:
            shutil.rmtree(self.path, ignore_errors=True)


def sweep_stale_runs(runs: Path) -> list[str]:
    """Remove run directories left behind by processes that are gone.

    Only ever called against the cache directory's own `runs/`, never against a
    `--workdir` someone named: a user's directory is theirs, and a heuristic
    about process liveness has no business deleting from it.
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
