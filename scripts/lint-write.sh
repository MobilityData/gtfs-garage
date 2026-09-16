#!/usr/bin/env bash
#
# Formats the code in place, then lints.
#
source "$(dirname -- "$0")/_common.sh"
ensure_python dev

python -m black src tests
python -m flake8 src tests
