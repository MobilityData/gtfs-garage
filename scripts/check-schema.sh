#!/usr/bin/env bash
# Check schema/gtfs.yaml as LinkML, and that the committed document matches it.
#
# Needs the `schema` extra:  pip install -e '.[schema]'
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> validating schema/gtfs.yaml as LinkML"
python - <<'PY'
from linkml.generators.pythongen import PythonGenerator
from linkml.generators.jsonschemagen import JsonSchemaGenerator

# Generating is the strict check: it is what rejects illegal constructs such as
# a class with more than one `identifier`, which a plain YAML parse accepts.
for generator in (PythonGenerator, JsonSchemaGenerator):
    generator("schema/gtfs.yaml").serialize()
    print(f"    {generator.__name__}: ok")
PY

echo "==> checking the packaged document is in sync"
# Compared against the file's own current content rather than against git, so
# this says the same thing in CI and in a working tree with other edits.
fresh="$(mktemp -t gtfs-schema)"
trap 'rm -f "$fresh"' EXIT
python scripts/build_schema_json.py --out "$fresh" >/dev/null

if ! diff -q "$fresh" src/gtfs_garage/data/gtfs-schema.json >/dev/null; then
    echo "ERROR: src/gtfs_garage/data/gtfs-schema.json does not match schema/gtfs.yaml." >&2
    echo "Run: python scripts/build_schema_json.py, and commit the result." >&2
    diff -u src/gtfs_garage/data/gtfs-schema.json "$fresh" | head -40 >&2
    exit 1
fi
echo "    packaged document is in sync"
