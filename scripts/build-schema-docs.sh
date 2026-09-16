#!/usr/bin/env bash
#
# Generate the human-readable schema reference (docs/SCHEMA.md) from the LinkML.
#
# Usage:
#   build-schema-docs.sh [--schema PATH] [--out PATH]
#
source "$(dirname -- "$0")/_common.sh"
ensure_python schema

exec python scripts/build_schema_docs.py "$@"
