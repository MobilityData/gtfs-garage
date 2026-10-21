#!/usr/bin/env bash
#
# Build the Quality catalog from schema/validator/rules.json and schema/guides/.
#
# Usage:
#   build-guides.sh [--out PATH]
#
# Checks every guide against the validator's own field names and writes
# src/gtfs_garage/data/guides.json, which is committed. tests/test_guides.py
# regenerates it and fails if the committed copy has drifted.
#
source "$(dirname -- "$0")/_common.sh"
ensure_python

exec python scripts/build_guides.py "$@"
