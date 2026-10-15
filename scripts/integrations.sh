#!/usr/bin/env bash
#
# Drive every way the viewer can be deployed, in a real browser.
#
# Usage:
#   integrations.sh                    # all four
#   integrations.sh local embedded     # just those
#
#   local      the standalone application: load dialog, options menu, map
#   embedded   a host's page: the browse half, with a back stack of its own
#   rest       a host mounting the REST source itself, with a map
#   static     Parquet on a static host, read in the browser by DuckDB-WASM
#
# The unit suites cover the pieces; this covers the configurations, which is
# where the defects have been. Needs a browser, so it is not part of
# scripts/tests.sh - run it before changing anything that mounts the viewer.
#
# Every server it starts gets a workdir of its own under the system temp
# directory, so a run never touches - or evicts from - the shared workdir under
# your platform cache.
#
source "$(dirname -- "$0")/_common.sh"
ensure_python perf
ensure_models

if ! python -c "import playwright" >/dev/null 2>&1; then
    die "playwright is required: pip install -e '.[dev,perf]' && playwright install chromium"
fi

step "Building the frontend, so the application serves what is in the tree"
(cd "$REPO_ROOT/web" && yarn build >/dev/null) || die "the frontend build failed"

exec python "$REPO_ROOT/scripts/integration_checks.py" "$@"
