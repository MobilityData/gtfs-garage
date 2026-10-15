#!/bin/bash

#
# Start every integration at once, for looking at by hand.
#
# scripts/integrations.sh drives these same four configurations in a headless
# browser and tells you whether they pass. This is the other half: it starts
# them and leaves them running, so you can open each one in your own browser
# and see what a host's user sees.
#
# Four configurations, one feed, one command:
#
#   local      the standalone application - load dialog, options menu, map
#   embedded   a host's own page: the browse half, no map, private back stack
#   rest       a host mounting the REST source itself, with a map
#   static     Parquet on a static host, read in the browser by DuckDB-WASM.
#              This is what MobilityData's operations web app runs: it embeds
#              the npm viewer with ParquetSource against the public bucket and
#              never calls this HTTP API at all
#
# Usage:
#   run-integrations.sh [FEED] [options]
#
# Arguments:
#   FEED                    : GTFS zip or folder to open.
#                             Default tests/data/explore-gtfs. (optional)
#
# Options:
#   --port <PORT>           : Port for the API. Default 8811. (optional)
#   --web-port <PORT>       : Port for the interface. Default 8830. (optional)
#   --bucket-port <PORT>    : Port for the emulated dataset bucket.
#                             Default 8831. (optional)
#   --skip-install          : Do not check or install dependencies. (optional)
#   --help                  : Display this help content.
#
# Examples:
#   Every integration against the test fixture:
#     ./run-integrations.sh
#
#   Against a real feed:
#     ./run-integrations.sh ~/feeds/stm.zip
#
# The default ports deliberately avoid 8821-8823, which scripts/integrations.sh
# binds, so a manual session and an automated run can overlap.
#
source "$(dirname -- "$0")/_common.sh"

FEED="$REPO_ROOT/tests/data/explore-gtfs"
API_PORT=8811
WEB_PORT=8830
BUCKET_PORT=8831
SKIP_INSTALL=false

GREEN='\033[0;32m'
BOLD='\033[1m'

display_usage() {
  sed -n '3,43p' "$0" | sed 's/^#//; s/^ //'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
  --port) [ $# -ge 2 ] || die "--port needs a value"; API_PORT="$2"; shift 2 ;;
  --web-port) [ $# -ge 2 ] || die "--web-port needs a value"; WEB_PORT="$2"; shift 2 ;;
  --bucket-port) [ $# -ge 2 ] || die "--bucket-port needs a value"; BUCKET_PORT="$2"; shift 2 ;;
  --skip-install) SKIP_INSTALL=true; shift ;;
  --help) display_usage; exit 0 ;;
  -*) die "unknown option $1 (try --help)" ;;
  *)
    FEED="$1"; shift ;;
  esac
done

[ -e "$FEED" ] || die "no such feed: $FEED"

# ---------------------------------------------------------------- dependencies

if [ "$SKIP_INSTALL" = false ]; then
  ensure_python dev
  command -v yarn >/dev/null 2>&1 || die "yarn is required but not installed (https://yarnpkg.com)"
  if [ ! -d web/node_modules ] || [ web/package.json -nt web/node_modules ]; then
    step "Installing the frontend dependencies"
    (cd web && yarn install --silent) || die "yarn install failed"
  fi
  ensure_models
else
  [ -x "$VENV/bin/python" ] || die "no Python environment at $VENV (drop --skip-install to create one)"
  export PATH="$VENV/bin:$PATH"
fi

# Everything this run writes goes here, and goes away with it: a workdir of its
# own so the shared one under your platform cache is neither read nor evicted
# from, and the Parquet export the static integration reads.
SESSION="$(mktemp -d -t gtfs-garage-integrations)"
WORKDIR="$SESSION/workdir"
DATASET="$SESSION/dataset"
mkdir -p "$WORKDIR"

# Job control, so each server below becomes its own process group and can be
# stopped with its children. `yarn dev` spawns vite as a child: killing the
# wrapper alone leaves vite holding the port, and the next run fails to bind.
set -m

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    # The group first, the process itself as the fallback for a server that
    # never became a group leader.
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  done
  rm -rf "$SESSION"
}
trap cleanup EXIT INT TERM

# --------------------------------------------------------------------- servers

step "Converting the feed to Parquet for the static integration"
"$VENV/bin/gtfs-garage" "$FEED" --export "$DATASET" --workdir "$WORKDIR" >/dev/null \
  || die "the Parquet export failed"

step "Starting the API on port $API_PORT"
"$VENV/bin/gtfs-garage" "$FEED" --workdir "$WORKDIR" --port "$API_PORT" --no-browser &
PIDS+=($!)

# The same handler scripts/integration_checks.py serves the bucket with, so
# what you click is what CI drives: CORS, and range requests rather than a 200
# with the whole body - which is the difference between DuckDB-WASM reading a
# footer and it downloading the file.
step "Serving the dataset on port $BUCKET_PORT, the way the bucket serves one"
"$VENV/bin/python" - "$DATASET" "$BUCKET_PORT" <<'PY' &
import sys
import threading
from pathlib import Path

# _common.sh leaves us at the repository root.
sys.path.insert(0, "scripts")
from integration_checks import static_server  # noqa: E402

with static_server(Path(sys.argv[1]), int(sys.argv[2])):
    threading.Event().wait()
PY
PIDS+=($!)

step "Starting the interface on port $WEB_PORT"
export GTFS_GARAGE_API_PORT="$API_PORT"
(cd web && yarn dev --port "$WEB_PORT" --strictPort) &
PIDS+=($!)

# ------------------------------------------------------------------------ URLs

# Waited for rather than slept on: vite is usually up in under a second and the
# first Parquet export can take several, so a fixed sleep either wastes time or
# prints URLs that are not answering yet.
wait_for() {
  local url="$1" name="$2" deadline=$((SECONDS + 90))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; then return 0; fi
    sleep 0.3
  done
  die "$name never answered at $url"
}

wait_for "http://127.0.0.1:$API_PORT/api/config" "the API"
wait_for "http://127.0.0.1:$BUCKET_PORT/manifest.json" "the dataset bucket"
# localhost, not 127.0.0.1: vite binds the hostname, and on a machine with IPv6
# the two are not the same socket.
wait_for "http://localhost:$WEB_PORT/integration-harness.html" "the interface"

HARNESS="http://localhost:$WEB_PORT/integration-harness.html"

printf "\n${GREEN}Ready${NC} — open each of these:\n\n"
printf "  ${BOLD}local${NC}      http://127.0.0.1:$API_PORT/\n"
printf "             the standalone application\n\n"
printf "  ${BOLD}embedded${NC}   $HARNESS?mode=embedded\n"
printf "             a host's page: the browse half, no map, private back stack\n\n"
printf "  ${BOLD}rest${NC}       $HARNESS?mode=rest\n"
printf "             a host mounting the REST source itself, with a map\n\n"
printf "  ${BOLD}static${NC}     $HARNESS?mode=static&dataset=http://127.0.0.1:$BUCKET_PORT\n"
printf "             Parquet read in the browser — what the operations web app runs\n\n"
printf "  Feed: %s\n" "$FEED"
printf "  window.harness in the console reports what was actually mounted.\n"
printf "  Ctrl-C stops all three servers and removes %s\n\n" "$SESSION"

wait
