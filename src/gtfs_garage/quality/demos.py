"""Feeds to try Quality tours on, each with what gtfs-validator reported for it.

A tour is written against one notice, and trying it needs a sample of that
notice and the feed the sample was found in. A demo is that pair: a feed and its
report. Two kinds:

- built in: the feeds in `data/demos/`, made to trigger as many notices as the
  validator can emit, with the report the validator wrote for each;
- the user's own: a feed already in the workdir, with a report they add. Kept
  under `<workdir>/demos/<id>/`, as `demo.json` and `report.json`.

Opening a built-in demo loads it like any feed, into a slot of its own whose
kind is `demo`; `Workspace.enforce_retention` neither counts nor evicts those,
so trying tours never pushes someone's own feeds out of the workdir. A feed an
own demo names is protected from retention for the same reason.
"""

from __future__ import annotations

import json
import re
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb

from gtfs_garage_core.workspace import Workspace

BUILTIN_DIR = Path(__file__).resolve().parent.parent / "data" / "demos"
CATALOG = "demos.json"
OWN_DIR = "demos"
OWN_RECORD = "demo.json"
OWN_REPORT = "report.json"


class DemoError(ValueError):
    pass


@dataclass(frozen=True)
class Demo:
    id: str
    title: str
    description: str
    builtin: bool
    report_path: Path
    # Built in: the directory holding the feed's files.
    feed_path: Path | None = None
    # The user's own: the workdir slot holding the feed.
    feed_id: str | None = None


def _feed_directory(root: Path) -> Path:
    """Where a built-in feed's files are: the directory, or the one folder inside it that has them."""
    if any(root.glob("*.txt")):
        return root
    inner = [child for child in root.iterdir() if child.is_dir() and any(child.glob("*.txt"))]
    return inner[0] if len(inner) == 1 else root


def builtin_demos(directory: Path = BUILTIN_DIR) -> list[Demo]:
    try:
        listed = json.loads((directory / CATALOG).read_text(encoding="utf-8"))["demos"]
    except (OSError, ValueError, KeyError):
        return []
    demos = []
    for entry in listed:
        root = directory / entry["id"]
        report = directory / f"{entry['id']}.report.json"
        if root.is_dir() and report.is_file():
            demos.append(
                Demo(
                    id=entry["id"],
                    title=entry.get("title") or entry["id"],
                    description=entry.get("description") or "",
                    builtin=True,
                    report_path=report,
                    feed_path=_feed_directory(root),
                )
            )
    return demos


def _own_root(workspace: Workspace) -> Path:
    return workspace.path / OWN_DIR


def own_demos(workspace: Workspace) -> list[Demo]:
    demos = []
    root = _own_root(workspace)
    for directory in sorted(root.glob("*")) if root.is_dir() else []:
        try:
            record = json.loads((directory / OWN_RECORD).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        demos.append(
            Demo(
                id=directory.name,
                title=str(record.get("title") or directory.name),
                description=str(record.get("description") or ""),
                builtin=False,
                report_path=directory / OWN_REPORT,
                feed_id=str(record.get("feed_id") or ""),
            )
        )
    return demos


def all_demos(workspace: Workspace) -> list[Demo]:
    return builtin_demos() + own_demos(workspace)


def find(workspace: Workspace, demo_id: str) -> Demo | None:
    return next((demo for demo in all_demos(workspace) if demo.id == demo_id), None)


def read_report(demo: Demo) -> dict[str, Any]:
    return json.loads(demo.report_path.read_text(encoding="utf-8"))


def notice_counts(report: dict[str, Any]) -> dict[str, int]:
    """How many times each notice code occurs in a report."""
    counts: dict[str, int] = {}
    for notice in report.get("notices") or []:
        code = notice.get("code")
        if isinstance(code, str):
            samples = notice.get("sampleNotices")
            fallback = len(samples) if isinstance(samples, list) else 0
            counts[code] = int(notice.get("totalNotices") or fallback)
    return counts


def available(workspace: Workspace, demo: Demo) -> bool:
    """Whether the demo can be opened: its feed is still there."""
    if demo.builtin:
        return demo.feed_path is not None and demo.feed_path.is_dir()
    entry = next((e for e in workspace.entries() if e.id == demo.feed_id), None)
    return entry is not None and entry.reloadable


def tables(workspace: Workspace, demo: Demo) -> list[dict[str, Any]]:
    """Each file of the demo's feed and its columns, read without loading the feed.

    Enough to check a tour against the demo - which rows a locator would find
    in which file - before running it, which does load the feed.
    """
    if demo.builtin:
        found = []
        for path in sorted(demo.feed_path.glob("*.txt")) if demo.feed_path else []:
            with path.open(encoding="utf-8-sig", errors="replace") as handle:
                header = handle.readline().strip()
            found.append(
                {"name": path.stem, "columns": [column.strip().strip('"') for column in header.split(",") if column]}
            )
        if demo.feed_path and (demo.feed_path / "locations.geojson").is_file():
            found.append({"name": "locations", "columns": ["id"]})
        return found
    slot = workspace.existing(demo.feed_id or "")
    if slot is None:
        return []
    found = []
    with duckdb.connect() as connection:
        for path in sorted(slot.parquet_dir.glob("*.parquet")):
            try:
                described = connection.execute("DESCRIBE SELECT * FROM read_parquet(?)", [str(path)]).fetchall()
            except duckdb.Error:
                continue
            found.append(
                {"name": path.stem, "columns": [row[0] for row in described if not str(row[0]).startswith("_")]}
            )
    return found


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "demo"


def add_own(workspace: Workspace, feed_id: str, title: str, report_text: str, description: str = "") -> Demo:
    """Keep a feed of the workdir and its report as a demo."""
    entry = next((e for e in workspace.entries() if e.id == feed_id), None)
    if entry is None or not entry.reloadable:
        raise DemoError("That feed is not in the workdir.")
    try:
        report = json.loads(report_text)
    except ValueError as exc:
        raise DemoError(f"The report is not JSON: {exc}") from None
    if not isinstance(report, dict) or not isinstance(report.get("notices"), list):
        raise DemoError("That is not a gtfs-validator report: it has no list of notices.")

    demo_id = f"own-{_slug(title or entry.label)}-{uuid.uuid4().hex[:6]}"
    directory = _own_root(workspace) / demo_id
    directory.mkdir(parents=True)
    (directory / OWN_REPORT).write_text(report_text, encoding="utf-8")
    record = {"title": title or entry.label, "description": description, "feed_id": feed_id}
    (directory / OWN_RECORD).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return next(demo for demo in own_demos(workspace) if demo.id == demo_id)


def remove_own(workspace: Workspace, demo_id: str) -> bool:
    """Forget an own demo. Its feed stays in the workdir."""
    if demo_id != Path(demo_id).name or not demo_id.startswith("own-"):
        return False
    directory = _own_root(workspace) / demo_id
    if not directory.is_dir():
        return False
    shutil.rmtree(directory, ignore_errors=True)
    return True


def protected_feeds(workspace: Workspace) -> set[str]:
    """Workdir feeds an own demo names, which retention must not evict."""
    return {demo.feed_id for demo in own_demos(workspace) if demo.feed_id}
