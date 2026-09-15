# Contributing

## Setup

```bash
scripts/run-app.sh --dev            # installs everything, starts with hot reload
source .venv/bin/activate && pre-commit install   # only needed for pre-commit
```

Every script under `scripts/` creates and installs the environment it needs, so
none of them requires activating anything first, and all of them can be run from
any directory.

`run-app.sh` creates the virtual environment, installs the Python and frontend
dependencies and starts the tool. `--dev` serves the interface with hot reload
and restarts the API on Python changes, so neither side needs rebuilding while
you work.

## Before opening a pull request

```bash
scripts/lint-tests.sh   # flake8 + black, line length 120
scripts/tests.sh        # pytest, branch coverage must stay >= 80%
```

If you changed anything under `web/`:

```bash
cd web && yarn install && yarn typecheck && yarn test && yarn build
```

The build output in `src/gtfs_garage/web/` is deliberately not in version
control. CI builds it for pull requests and releases, so a wheel always ships a
current interface; from a checkout you build it yourself.

## Conventions

- Commit messages and pull request titles follow
  [Conventional Commits](https://www.conventionalcommits.org/).
- Nothing under `src/gtfs_garage/core/` may import a web framework — that is what
  lets other projects reuse the query layer. A test enforces it.
- Every database read takes its own `feed.cursor()`. A shared DuckDB connection
  returns wrong or empty results when requests overlap.
- New GTFS facts belong in `schema/gtfs.yaml`, not in Python, so the frontend
  sees them too. `src/gtfs_garage/data/gtfs-schema.json` is generated from it —
  edit the YAML, run `scripts/build-schema-json.sh`, and commit both.
  `scripts/check-schema.sh` validates the schema and checks the two agree; it
  needs `pip install -e '.[schema]'`.

## Releasing

Bump `__version__` in `src/gtfs_garage/__init__.py`, then tag `vX.Y.Z`. The
release workflow checks the tag matches the version, builds the frontend, and
publishes to PyPI.
