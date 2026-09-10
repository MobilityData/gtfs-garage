"""The core must stay usable without a web framework.

`mobility-feed-api` (or anything else) should be able to `pip install gtfs-garage`
and query a feed server-side without inheriting FastAPI. That only holds if no
module under `gtfs_garage.core` imports it, so this is checked rather than
assumed.
"""

import ast
from pathlib import Path

import gtfs_garage.core

CORE_DIR = Path(gtfs_garage.core.__file__).parent
WEB_PACKAGES = {"fastapi", "starlette", "uvicorn", "pydantic"}


def imported_top_level_packages(source: Path) -> set[str]:
    tree = ast.parse(source.read_text(encoding="utf-8"))
    packages: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            packages.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            packages.add(node.module.split(".")[0])
    return packages


def test_core_modules_exist():
    assert list(CORE_DIR.glob("*.py")), "expected modules under gtfs_garage.core"


def test_core_does_not_import_a_web_framework():
    offenders = {}
    for module in CORE_DIR.glob("*.py"):
        found = imported_top_level_packages(module) & WEB_PACKAGES
        if found:
            offenders[module.name] = sorted(found)
    assert not offenders, f"gtfs_garage.core must stay framework-free, but: {offenders}"


def test_core_can_be_imported_without_the_server_package():
    # Importing the core must not drag in the server module as a side effect.
    import subprocess
    import sys

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import gtfs_garage.core, sys; "
            "assert 'gtfs_garage.server' not in sys.modules; "
            "assert 'fastapi' not in sys.modules",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
