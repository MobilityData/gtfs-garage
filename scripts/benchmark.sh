#!/usr/bin/env bash
#
# Measures what opening and drawing a feed costs. Reports; never fails.
#
# Usage:
#   benchmark.sh [--json]      # --json emits the raw numbers for comparison
#
source "$(dirname -- "$0")/_common.sh"
ensure_python dev

exec python scripts/benchmark.py "$@"
