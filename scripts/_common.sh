#
# Shared preamble for the scripts in this directory. Sourced, not run - the
# leading underscore marks that.
#
# It does what run-app.sh has always done: find the repository, make sure the
# project's own Python environment exists and has what the script needs, and put
# that environment first on PATH. Without it a script runs against whatever
# `python` happens to be ambient, which is how `check-schema.sh` came to fail
# with "No module named 'linkml'" while `lint-tests.sh` passed using a globally
# installed flake8.
#
# Usage, at the top of a script:
#
#     source "$(dirname -- "$0")/_common.sh"
#     ensure_python dev
#

set -euo pipefail

# Resolved from this file rather than from $0, and absolutely, so a script works
# when it is invoked by relative path, by absolute path, or through a symlink,
# and from any working directory.
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
VENV="$REPO_ROOT/.venv"
cd "$REPO_ROOT"

RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

die() {
    printf "${RED}error:${NC} %s\n" "$1" >&2
    exit 1
}

# To stderr, like `die`. A wrapper's stdout may be the caller's data - CI pipes
# `benchmark.sh --json` into a file - and progress lines mixed into it are not
# recoverable from.
step() {
    printf "${YELLOW}==>${NC} %s\n" "$1" >&2
}

# Make sure .venv exists with the given extra installed, then put it on PATH.
#
# One stamp per extra. `dev`, `schema` and `perf` install different things, so a
# single shared stamp would let an environment installed for `dev` satisfy a
# script that needs `linkml` - which is the failure this exists to prevent.
ensure_python() {
    local extra="${1:-dev}"
    local stamp="$VENV/.install-stamp-$extra"

    command -v python3 >/dev/null 2>&1 || die "python3 is required but not installed"

    if [ ! -d "$VENV" ]; then
        step "Creating the Python environment"
        python3 -m venv "$VENV" || die "could not create $VENV"
    fi

    # Reinstall only when the declared dependencies are newer than the last
    # install for this extra, so the common case costs one stat.
    if [ ! -f "$stamp" ] || [ "$REPO_ROOT/pyproject.toml" -nt "$stamp" ]; then
        step "Installing the package with its '$extra' dependencies"
        "$VENV/bin/pip" install --quiet --upgrade pip || die "could not upgrade pip"
        "$VENV/bin/pip" install --quiet -e ".[$extra]" \
            || die "could not install the '$extra' dependencies"
        touch "$stamp"
    fi

    export PATH="$VENV/bin:$PATH"
}
