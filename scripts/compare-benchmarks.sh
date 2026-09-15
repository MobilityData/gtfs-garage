#!/usr/bin/env bash
#
# Diffs two benchmark runs and writes the result as markdown.
#
# Usage:
#   compare-benchmarks.sh BASE.json HEAD.json
#
# Both files come from `benchmark.sh --json`.
#
source "$(dirname -- "$0")/_common.sh"
ensure_python dev

exec python scripts/compare_benchmarks.py "$@"
