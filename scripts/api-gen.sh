#!/usr/bin/env bash
#
# Generate both sides of the API contract from docs/GtfsGarageAPI.yaml.
#
# Usage:
#   api-gen.sh
#
# Writes the server's pydantic models to src/gtfs_garage_gen/ and the viewer's
# TypeScript types to web/src/sources/api.gen.ts. Both are committed, so a clone
# needs none of this to run the app - scripts/_common.sh regenerates only when
# the spec has actually changed.
#
# Edit the YAML, run this, commit all three. tests/test_openapi.py checks the
# server still serves what the spec declares.
#
# Models only, not routers. The generator writes FastAPI handlers too, and they
# are deliberately unused: its handlers are `async def`, while every endpoint
# here is a plain `def` so a blocking query runs in a worker thread instead of
# starving the event loop. tests/test_performance_guards.py asserts that, and a
# generated router would fail it.
#
source "$(dirname -- "$0")/_common.sh"

GENERATOR_VERSION=7.5.0

SPEC="$REPO_ROOT/docs/GtfsGarageAPI.yaml"
CONFIG="$REPO_ROOT/scripts/gen-config.yaml"
CLI="$REPO_ROOT/scripts/bin/openapitools/openapi-generator-cli"
PACKAGE="gtfs_garage_gen"
TARGET="$REPO_ROOT/src/$PACKAGE"
TS_TARGET="$REPO_ROOT/web/src/sources/api.gen.ts"
# Generated into a scratch tree and copied in, rather than straight over the
# repository. The generator writes a pyproject.toml, a Dockerfile and a README
# beside its output; staging them keeps that out of the project, and means the
# files that do land are the generator's own and unedited - which is the only
# reason to trust a regeneration.
STAGING="$REPO_ROOT/build/api-gen"

[ -f "$SPEC" ] || die "no spec at $SPEC"
command -v java >/dev/null 2>&1 || die "java is required to run openapi-generator"

# Bootstrapped on demand rather than as a step someone has to know about.
[ -x "$CLI" ] && step "Using the cached openapi-generator wrapper" \
    || "$REPO_ROOT/scripts/setup-openapi-generator.sh"

# ------------------------------------------------------------- python models

step "Generating the server models"
rm -rf "$STAGING"
mkdir -p "$(dirname "$STAGING")"
OPENAPI_GENERATOR_VERSION=$GENERATOR_VERSION "$CLI" generate \
    -g python-fastapi \
    -i "$SPEC" \
    -o "$STAGING" \
    -c "$CONFIG" \
    --global-property models,modelTests=false,modelDocs=false \
    >"$STAGING.log" 2>&1 || {
    cat "$STAGING.log" >&2
    die "generation failed"
}

GENERATED="$STAGING/src/$PACKAGE/models"
[ -d "$GENERATED" ] || die "the generator wrote no models to $GENERATED"

rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -R "$GENERATED" "$TARGET/models"

# The package's own __init__ is ours: `--global-property models` writes the
# models and nothing else, so there is no generated one to take.
cat > "$TARGET/__init__.py" <<'PY'
"""Models generated from docs/GtfsGarageAPI.yaml. Do not edit by hand.

Regenerate with scripts/api-gen.sh after changing the spec.
"""
PY

# ------------------------------------------------------------ viewer types

# Best effort. A contributor working only on the Python side has no yarn and no
# node_modules, and should not be stopped by a frontend artifact that is already
# committed.
if command -v yarn >/dev/null 2>&1 && [ -d "$REPO_ROOT/web/node_modules" ]; then
    step "Generating the viewer types"
    (cd "$REPO_ROOT/web" && yarn --silent gen:api) \
        || die "could not generate $TS_TARGET"
else
    printf "${YELLOW}note:${NC} skipping web/src/sources/api.gen.ts - yarn or web/node_modules is missing.\n" >&2
    printf "      Run 'yarn install && yarn gen:api' in web/ to refresh it.\n" >&2
fi

# ------------------------------------------------------------------- stamp

# What ensure_models compares against, so an untouched spec never sends anyone
# looking for java.
spec_digest "$SPEC" > "$TARGET/.spec-sha256"

step "Done. $(find "$TARGET/models" -name '*.py' ! -name '__init__.py' | wc -l | tr -d ' ') models in src/$PACKAGE/models/"
