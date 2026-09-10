#!/bin/bash
#
# Runs the test suite with branch coverage and enforces the threshold.
#
set -e
SCRIPT_PATH="$(dirname -- "$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")")"
cd "$SCRIPT_PATH/.." || exit 1

COVERAGE_THRESHOLD=80

python -m coverage run --branch -m pytest -W 'ignore::DeprecationWarning' tests
python -m coverage report --fail-under=$COVERAGE_THRESHOLD
python -m coverage html -d coverage_reports
