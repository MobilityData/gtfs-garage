#!/bin/bash
#
# Formats the code in place, then lints.
#
set -e
SCRIPT_PATH="$(dirname -- "$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")")"
cd "$SCRIPT_PATH/.." || exit 1

python -m black src tests
python -m flake8 src tests
