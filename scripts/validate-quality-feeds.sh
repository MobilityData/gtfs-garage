#!/usr/bin/env bash
#
# Re-run gtfs-validator over the quality test feeds and refresh their reports.
#
# Usage:
#   validate-quality-feeds.sh [feed ...]
#
# Each directory under src/gtfs_garage/data/demos/ is a feed. It is zipped as it sits
# and validated with a fixed date and country, so the same feed always yields
# the same notices, and the report lands beside it as <feed>.report.json. A run
# that raises system errors also writes <feed>.system_errors.json; for the
# `crash` feed that file is the point.
#
# The volatile parts of a report - when it ran, how long it took, the memory it
# used and the temporary paths it read and wrote - are replaced with fixed
# values, so a refreshed report differs from the committed one only where the
# notices do.
#
# The validator CLI is downloaded once into scripts/bin/, which is not in
# version control. Needs java 17 or newer, curl, zip and python3.
#
source "$(dirname -- "$0")/_common.sh"

VALIDATOR_VERSION="8.0.1"
VALIDATION_DATE="2026-10-15"
COUNTRY_CODE="ca"

JAR_DIR="$REPO_ROOT/scripts/bin/gtfs-validator"
JAR="$JAR_DIR/gtfs-validator-$VALIDATOR_VERSION-cli.jar"
JAR_URL="https://github.com/MobilityData/gtfs-validator/releases/download/v$VALIDATOR_VERSION/gtfs-validator-$VALIDATOR_VERSION-cli.jar"
FEEDS_DIR="$REPO_ROOT/src/gtfs_garage/data/demos"

command -v java >/dev/null 2>&1 || die "java is required to run gtfs-validator"
command -v zip >/dev/null 2>&1 || die "zip is required to package the feeds"
command -v python3 >/dev/null 2>&1 || die "python3 is required to normalise the reports"

if [ ! -f "$JAR" ]; then
    step "Downloading gtfs-validator $VALIDATOR_VERSION"
    mkdir -p "$JAR_DIR"
    curl --fail --silent --show-error --location "$JAR_URL" --output "$JAR.part" \
        || die "could not download the validator from $JAR_URL"
    mv "$JAR.part" "$JAR"
fi

if [ "$#" -gt 0 ]; then
    feeds=("$@")
else
    feeds=()
    for dir in "$FEEDS_DIR"/*/; do
        feeds+=("$(basename -- "$dir")")
    done
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for feed in "${feeds[@]}"; do
    source_dir="$FEEDS_DIR/$feed"
    [ -d "$source_dir" ] || die "no feed called $feed in $FEEDS_DIR"
    step "Validating $feed"

    archive="$WORK/$feed.zip"
    output="$WORK/$feed"
    # Zipped from inside the directory, so a feed whose files sit in a folder
    # (the `subfolder` feed) keeps that folder inside the archive.
    (cd "$source_dir" && zip -q -r -X "$archive" .)

    java -jar "$JAR" \
        --input "$archive" \
        --output_base "$output" \
        --country_code "$COUNTRY_CODE" \
        --date "$VALIDATION_DATE" \
        --skip_validator_update \
        --pretty >"$WORK/$feed.log" 2>&1 \
        || die "gtfs-validator failed on $feed; see its log:\n$(tail -n 20 "$WORK/$feed.log")"

    python3 - "$output" "$FEEDS_DIR" "$feed" <<'PY'
import json, os, sys

output, feeds_dir, feed = sys.argv[1:]

def save(data, name):
    with open(os.path.join(feeds_dir, name), "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

with open(os.path.join(output, "report.json"), encoding="utf-8") as handle:
    report = json.load(handle)
summary = report.get("summary", {})
summary["gtfsInput"] = f"{feed}.zip"
summary["outputDirectory"] = ""
summary["validatedAt"] = "2026-10-15T00:00:00Z"
summary["validationTimeSeconds"] = 0
summary.pop("memoryUsageRecords", None)
save(report, f"{feed}.report.json")

errors_path = os.path.join(output, "system_errors.json")
target = os.path.join(feeds_dir, f"{feed}.system_errors.json")
with open(errors_path, encoding="utf-8") as handle:
    errors = json.load(handle)
if errors.get("notices"):
    for notice in errors["notices"]:
        for sample in notice.get("sampleNotices", []):
            # A Java stack trace names the machine's paths and changes with the JVM.
            sample.pop("stackTrace", None)
    save(errors, f"{feed}.system_errors.json")
elif os.path.exists(target):
    os.remove(target)
PY
done

step "Reports written to src/gtfs_garage/data/demos/"
