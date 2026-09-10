#!/bin/bash
#
# Checks formatting and lint. Run scripts/lint-write.sh to fix what it reports.
#
set -e
SCRIPT_PATH="$(dirname -- "$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")")"
cd "$SCRIPT_PATH/.." || exit 1

python -m flake8 src tests
python -m black src tests --check
