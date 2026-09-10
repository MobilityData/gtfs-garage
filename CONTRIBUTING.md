# Contributing

## Setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pre-commit install
```

## Before opening a pull request

```bash
scripts/lint-tests.sh   # flake8 + black, line length 120
scripts/tests.sh        # pytest, branch coverage must stay >= 80%
```

If you changed anything under `web/`, rebuild and commit the output:

```bash
cd web && npm install && npm run typecheck && npm run build
```

The built bundle in `src/gtfs_garage/web/` is committed so that `pip install`
never requires Node. CI fails if it is stale.

## Conventions

- Commit messages and pull request titles follow
  [Conventional Commits](https://www.conventionalcommits.org/).
- Nothing under `src/gtfs_garage/core/` may import a web framework — that is what
  lets other projects reuse the query layer. A test enforces it.
- Every database read takes its own `feed.cursor()`. A shared DuckDB connection
  returns wrong or empty results when requests overlap.
- New GTFS relationships belong in `src/gtfs_garage/data/gtfs-schema.json`, not
  in Python, so the frontend sees them too.

## Releasing

Bump `__version__` in `src/gtfs_garage/__init__.py`, update `CHANGELOG.md`, then
tag `vX.Y.Z`. The release workflow checks the tag matches the version and
publishes to PyPI.
