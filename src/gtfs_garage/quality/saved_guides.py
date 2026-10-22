"""Tours saved from the editor, kept in the workdir.

The tours the viewer ships are built into its catalog (`data/guides.json`) and
never change at runtime. A tour an analyst writes or changes is saved here, as
the YAML they wrote, under `<workdir>/guides/<code>.yaml`, and wins over the
built-in one for its notice until it is removed.

Every save is checked with `check_guide` against the fields the notice's
samples carry, the same check the build applies to `schema/guides/`, so a
saved tour is one the viewer can carry out and one the repository would accept.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from functools import lru_cache
from importlib import resources
from pathlib import Path
from typing import Any

import yaml

from gtfs_garage.quality.guides import GuideError, check_guide
from gtfs_garage_core.workspace import Workspace

GUIDES_DIR = "guides"


@lru_cache(maxsize=1)
def _catalog() -> dict[str, Any]:
    text = resources.files("gtfs_garage").joinpath("data", "guides.json").read_text(encoding="utf-8")
    return json.loads(text)


def notice_fields(code: str) -> set[str] | None:
    """The fields a notice's samples carry, or None for a code the validator does not emit."""
    notice = _catalog()["notices"].get(code)
    return None if notice is None else set((notice.get("fields") or {}).keys())


def _directory(workspace: Workspace) -> Path:
    return workspace.path / GUIDES_DIR


def _path(workspace: Workspace, code: str) -> Path | None:
    """Where `code`'s tour is kept, or None for a code that is not one: nothing traverses."""
    if notice_fields(code) is None or code != Path(code).name:
        return None
    return _directory(workspace) / f"{code}.yaml"


def _entry(code: str, path: Path) -> dict[str, Any] | None:
    try:
        text = path.read_text(encoding="utf-8")
        guide = yaml.safe_load(text)
    except (OSError, yaml.YAMLError):
        return None
    saved = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat(timespec="seconds")
    return {"code": code, "yaml": text, "guide": guide, "saved_at": saved}


def list_saved(workspace: Workspace) -> list[dict[str, Any]]:
    """Every tour saved in the workdir, by notice code."""
    directory = _directory(workspace)
    found = []
    for path in sorted(directory.glob("*.yaml")) if directory.is_dir() else []:
        if notice_fields(path.stem) is None:
            continue
        entry = _entry(path.stem, path)
        if entry is not None:
            found.append(entry)
    return found


def get(workspace: Workspace, code: str) -> dict[str, Any] | None:
    path = _path(workspace, code)
    return _entry(code, path) if path is not None and path.is_file() else None


def save(workspace: Workspace, code: str, text: str) -> dict[str, Any]:
    """Check `text` as the tour for `code` and keep it. Raises GuideError, saving nothing, when it fails."""
    path = _path(workspace, code)
    if path is None:
        raise GuideError(f"The validator has no notice called {code!r}.")
    try:
        guide = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise GuideError(f"{code}.yaml is not YAML: {exc}") from None
    check_guide(code, guide, notice_fields(code) or set())
    path.parent.mkdir(parents=True, exist_ok=True)
    # Written beside and moved over, so a reader never sees half a file.
    partial = path.with_suffix(".yaml.part")
    partial.write_text(text if text.endswith("\n") else text + "\n", encoding="utf-8")
    os.replace(partial, path)
    return _entry(code, path) or {"code": code, "yaml": text, "guide": guide, "saved_at": ""}


def remove(workspace: Workspace, code: str) -> bool:
    path = _path(workspace, code)
    if path is None or not path.is_file():
        return False
    path.unlink()
    return True
