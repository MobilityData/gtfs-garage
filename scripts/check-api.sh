#!/usr/bin/env bash
#
# Check that the committed generated code is what docs/GtfsGarageAPI.yaml produces.
#
# Usage:
#   check-api.sh
#
# src/gtfs_garage_gen/ and web/src/sources/api.gen.ts are generated and
# committed, so they can go stale or be edited by hand. Regenerating and
# comparing is what stops that - the same thing scripts/check-schema.sh does for
# the packaged schema document.
#
# tests/test_openapi.py checks the cheaper half of this without java: that the
# spec has not moved since the last generation. It cannot tell whether the
# committed files are the generator's own output, which is what this is for.
#
source "$(dirname -- "$0")/_common.sh"

command -v java >/dev/null 2>&1 || die "java is required to run openapi-generator"

fresh="$(mktemp -d -t gtfs-garage-api)"
trap 'rm -rf "$fresh"' EXIT

echo "==> regenerating from docs/GtfsGarageAPI.yaml"
scripts/api-gen.sh --out "$fresh" >/dev/null || die "generation failed"

# A half-regenerated tree is unstamped, and a comparison against it would report
# every file as current while the viewer's types were never rebuilt.
[ -f "$fresh/gtfs_garage_gen/.spec-sha256" ] \
    || die "the regeneration did not produce the viewer types; run 'yarn install' in web/"

stale() {
    echo "ERROR: $1 does not match docs/GtfsGarageAPI.yaml." >&2
    echo "Run: scripts/api-gen.sh, and commit the result." >&2
    shift
    "$@" | head -40 >&2
    exit 1
}

# -x __pycache__: a working tree that has imported the package has bytecode in
# it, and the fresh one never does.
echo "==> checking the server models are in sync"
diff -r -x __pycache__ "$fresh/gtfs_garage_gen" src/gtfs_garage_gen >/dev/null 2>&1 \
    || stale "src/gtfs_garage_gen/" diff -ru -x __pycache__ src/gtfs_garage_gen "$fresh/gtfs_garage_gen"
echo "    server models are in sync"

echo "==> checking the viewer types are in sync"
diff -q "$fresh/api.gen.ts" web/src/sources/api.gen.ts >/dev/null 2>&1 \
    || stale "web/src/sources/api.gen.ts" diff -u web/src/sources/api.gen.ts "$fresh/api.gen.ts"
echo "    viewer types are in sync"
