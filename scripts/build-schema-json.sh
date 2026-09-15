#!/usr/bin/env bash
#
# Generate the packaged schema document from schema/gtfs.yaml.
#
# Usage:
#   build-schema-json.sh [--schema PATH] [--out PATH]
#
# The generated file is committed; scripts/check-schema.sh checks the two agree.
#
source "$(dirname -- "$0")/_common.sh"
ensure_python schema

exec python scripts/build_schema_json.py "$@"
