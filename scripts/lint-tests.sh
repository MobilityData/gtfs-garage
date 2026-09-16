#!/usr/bin/env bash
#
# Checks formatting and lint. Run scripts/lint-write.sh to fix what it reports.
#
source "$(dirname -- "$0")/_common.sh"
ensure_python dev

python -m flake8 src tests
python -m black src tests --check
