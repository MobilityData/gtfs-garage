#!/usr/bin/env bash
#
# Runs the test suite with branch coverage and enforces the threshold.
#
source "$(dirname -- "$0")/_common.sh"
ensure_python dev
# The tests import the generated models, so they have to match the spec.
ensure_models

COVERAGE_THRESHOLD=80

python -m coverage run --branch -m pytest -W 'ignore::DeprecationWarning' tests
python -m coverage report --fail-under=$COVERAGE_THRESHOLD
python -m coverage html -d coverage_reports
