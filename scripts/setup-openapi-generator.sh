#!/usr/bin/env bash
#
# Fetch the openapi-generator CLI wrapper, once.
#
# Usage:
#   setup-openapi-generator.sh
#
# The wrapper is a shell script that downloads and caches the generator jar for
# whichever version is asked of it, which is what lets scripts/api-gen.sh pin a
# version rather than depending on whatever is installed. It lands in
# scripts/bin/, which is not in version control.
#
# Same tool and same layout as mobility-feed-api, so a MobilityData contributor
# moving between the two repositories finds the command where they expect it.
#
source "$(dirname -- "$0")/_common.sh"

BIN_DIR="$REPO_ROOT/scripts/bin/openapitools"
CLI="$BIN_DIR/openapi-generator-cli"
SOURCE_URL="https://raw.githubusercontent.com/OpenAPITools/openapi-generator/master/bin/utils/openapi-generator-cli.sh"

command -v java >/dev/null 2>&1 || die "java is required to run openapi-generator"

step "Downloading the openapi-generator CLI wrapper"
mkdir -p "$BIN_DIR"
curl --fail --silent --show-error --location "$SOURCE_URL" --output "$CLI" \
    || die "could not download the generator wrapper from $SOURCE_URL"
chmod u+x "$CLI"

step "Ready. Run scripts/api-gen.sh to regenerate the models."
