#!/bin/bash

#
# This script prepares everything the tool needs and starts it: a Python virtual
# environment with the package installed, the frontend dependencies, and the
# built interface. It is safe to run repeatedly and from a fresh clone.
#
# Usage:
#   run-app.sh [FEED] [options]
#
# Arguments:
#   FEED                    : GTFS zip file or extracted folder to open. (optional)
#
# Options:
#   --dev                   : Hot-reload mode. Frontend and Python changes apply
#                             without rebuilding or restarting. (optional)
#   --port <PORT>           : Port for the application. Default 8811. (optional)
#   --basemap <NAME|URL>    : openfreemap (default), esri, osm, carto, none, or a
#                             tile template or style URL. (optional)
#   --skip-install          : Do not check or install dependencies. (optional)
#   --no-browser            : Do not open a browser tab. (optional)
#   --help                  : Display this help content.
#
# Examples:
#   Set everything up and open a feed:
#     ./run-app.sh ~/feeds/stm.zip
#
#   Work on the code with hot reload:
#     ./run-app.sh ~/feeds/stm.zip --dev
#
#   Run without a basemap on a different port:
#     ./run-app.sh ~/feeds/stm.zip --basemap none --port 9000

# REPO_ROOT, VENV, die, step and ensure_python all come from here, so this
# script and every other one bootstrap the environment the same way.
source "$(dirname -- "$0")/_common.sh"

FEED=""
PORT=8811
BASEMAP=""
DEV=false
SKIP_INSTALL=false
NO_BROWSER=false

GREEN='\033[0;32m'

display_usage() {
  sed -n '3,32p' "$0" | sed 's/^#//; s/^ //'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
  --dev) DEV=true; shift ;;
  --port) [ $# -ge 2 ] || die "--port needs a value"; PORT="$2"; shift 2 ;;
  --basemap) [ $# -ge 2 ] || die "--basemap needs a value"; BASEMAP="$2"; shift 2 ;;
  --skip-install) SKIP_INSTALL=true; shift ;;
  --no-browser) NO_BROWSER=true; shift ;;
  --help) display_usage; exit 0 ;;
  -*) die "unknown option $1 (try --help)" ;;
  *)
    [ -n "$FEED" ] && die "only one feed can be given, got '$FEED' and '$1'"
    FEED="$1"; shift ;;
  esac
done

# The feed is checked after parsing so that --help works without one.
if [ -n "$FEED" ] && [ ! -e "$FEED" ]; then
  die "no such feed: $FEED"
fi

# ---------------------------------------------------------------- dependencies

if [ "$SKIP_INSTALL" = false ]; then
  ensure_python dev

  command -v yarn >/dev/null 2>&1 || die "yarn is required but not installed (https://yarnpkg.com)"
  if [ ! -d web/node_modules ] || [ web/package.json -nt web/node_modules ]; then
    step "Installing the frontend dependencies"
    (cd web && yarn install --silent) || die "yarn install failed"
  fi
else
  # Nothing is installed or checked, so the environment has to already be there.
  [ -x "$VENV/bin/python" ] || die "no Python environment at $VENV (drop --skip-install to create one)"
  export PATH="$VENV/bin:$PATH"
fi
[ -n "$BASEMAP" ] && export GTFS_GARAGE_BASEMAP="$BASEMAP"

# ----------------------------------------------------------------------- start

if [ "$DEV" = true ]; then
  # Two servers: the API, and Vite serving the interface with hot reload and
  # proxying data requests to it. Nothing is rebuilt to see a change.
  export GTFS_GARAGE_FEED="$FEED"
  export GTFS_GARAGE_API_PORT="$PORT"

  step "Starting the API on port $PORT (reloads on Python changes)"
  "$VENV/bin/python" -m uvicorn --factory gtfs_garage.server.app:create_app \
    --reload --port "$PORT" &
  API_PID=$!
  trap 'kill $API_PID 2>/dev/null || true' EXIT INT TERM

  step "Starting the interface with hot reload"
  cd web || die "cannot enter web/"
  if [ "$NO_BROWSER" = true ]; then
    exec yarn dev
  else
    exec yarn dev --open
  fi
fi

step "Building the interface"
(cd web && yarn build) || die "frontend build failed"

step "Starting GTFS Garage on port $PORT"
ARGS=(--port "$PORT")
[ -n "$FEED" ] && ARGS+=("$FEED")
[ -n "$BASEMAP" ] && ARGS+=(--basemap "$BASEMAP")
[ "$NO_BROWSER" = true ] && ARGS+=(--no-browser)

printf "${GREEN}Ready${NC}\n"
exec "$VENV/bin/gtfs-garage" "${ARGS[@]}"
