#!/usr/bin/env bash
#
# Formats the code in place, then lints.
#
source "$(dirname -- "$0")/_common.sh"
ensure_python dev

python -m black src core/src tests
python -m flake8 src core/src tests
