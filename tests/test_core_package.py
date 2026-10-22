"""`gtfs-garage-core` as its own distribution.

The core is published separately so a project can convert and query feeds
without a web server. That holds only while its dependencies stay small, it
never reaches back into the application, the two packages keep the same
version, and code written against the old `gtfs_garage.core` path still gets
the same modules.
"""

from __future__ import annotations

import importlib
import pkgutil
import re
import subprocess
import sys
import tomllib
from importlib import metadata, resources
from pathlib import Path
from unittest import mock

import gtfs_garage
import gtfs_garage_core

ROOT = Path(__file__).resolve().parent.parent
CORE_ALLOWED_DEPENDENCIES = {"duckdb"}


def _name(requirement: str) -> str:
    return re.split(r"[\s;<>=~!\[]", requirement, maxsplit=1)[0].lower()


def test_the_core_depends_only_on_duckdb():
    declared = tomllib.loads((ROOT / "core" / "pyproject.toml").read_text(encoding="utf-8"))
    assert {_name(r) for r in declared["project"]["dependencies"]} == CORE_ALLOWED_DEPENDENCIES


def test_the_installed_core_requires_no_web_framework():
    # The metadata pip resolves from, rather than the file it was built from.
    required = {_name(r) for r in metadata.requires("gtfs-garage-core") or [] if "extra ==" not in r}
    assert required == CORE_ALLOWED_DEPENDENCIES


def test_the_two_packages_are_released_in_lockstep():
    app = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    pins = [r for r in app["project"]["dependencies"] if _name(r) == "gtfs-garage-core"]
    assert pins == [f"gtfs-garage-core=={gtfs_garage_core.__version__}"]
    assert gtfs_garage.__version__ == gtfs_garage_core.__version__


def test_the_core_does_not_import_the_application():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, gtfs_garage_core, gtfs_garage_core.convert; "
            "leaked = sorted(m for m in sys.modules if m == 'gtfs_garage' or m.startswith('gtfs_garage.') "
            "or m.split('.')[0] in {'fastapi', 'starlette', 'uvicorn', 'pydantic'}); "
            "assert not leaked, leaked",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_the_old_import_path_is_the_same_package():
    import gtfs_garage.core

    assert gtfs_garage.core is gtfs_garage_core
    for module in pkgutil.iter_modules(gtfs_garage_core.__path__):
        old = importlib.import_module(f"gtfs_garage.core.{module.name}")
        assert old is importlib.import_module(f"gtfs_garage_core.{module.name}"), module.name


def test_names_imported_from_the_old_path_are_the_same_objects():
    from gtfs_garage.core.feed import GtfsFeed as Old
    from gtfs_garage_core.feed import GtfsFeed as New

    assert Old is New


def test_patching_through_the_old_path_reaches_the_core():
    from gtfs_garage_core import workspace

    with mock.patch("gtfs_garage.core.workspace.DEFAULT_KEEP", 99):
        assert workspace.DEFAULT_KEEP == 99


def test_the_packaged_data_is_found_under_both_names():
    for package in ("gtfs_garage_core.data", "gtfs_garage.data"):
        data = resources.files(package)
        assert data.joinpath("gtfs-schema.json").is_file(), package
