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
- Nothing under `core/src/gtfs_garage_core/` may import a web framework — that is what
  lets other projects reuse the query layer. A test enforces it.
- Every database read takes its own `feed.cursor()`. A shared DuckDB connection
  returns wrong or empty results when requests overlap.
- New GTFS facts belong in `schema/gtfs.yaml`, not in Python, so the frontend
  sees them too. `core/src/gtfs_garage_core/data/gtfs-schema.json` is generated from it —
  edit the YAML, run `scripts/build-schema-json.sh`, and commit both.
  `scripts/check-schema.sh` validates the schema and checks the two agree; it
  needs `pip install -e ./core -e '.[schema]'`.

## Releasing

The repository publishes two Python packages at one version: `gtfs-garage-core`
from `core/` (loading, converting and querying, no web server) and
`gtfs-garage`, which pins the core exactly. Bump `__version__` in both
`src/gtfs_garage/__init__.py` and `core/src/gtfs_garage_core/__init__.py`, and
the `gtfs-garage-core==` pin in `pyproject.toml`, to the same version;
`version-python.yml` refuses a pull request where they differ. The release
workflow then builds the frontend and publishes both packages to PyPI.

For a local environment by hand, install the two together so the pin is met
from the checkout: `pip install -e ./core -e '.[dev]'`. The scripts do this.
