#!/usr/bin/env bash
# Build the browsable schema site from schema/gtfs.yaml.
#
# LinkML's docgen emits one Markdown page per class, slot and enum; MkDocs turns
# those into the searchable site that gets published. Everything lands in
# build/, which is not in version control - the published copy is whatever CI
# last built.
#
# Usage:
#   build-schema-site.sh [--serve]
#
source "$(dirname -- "$0")/_common.sh"
ensure_python schema

OUT="build/schema-site"
PAGES="$OUT/docs"
SERVE=false
[ "${1:-}" = "--serve" ] && SERVE=true

rm -rf "$OUT"
mkdir -p "$PAGES"

echo "==> generating pages from schema/gtfs.yaml"
gen-doc schema/gtfs.yaml -d "$PAGES"

# The single-page reference is what most people want, so it leads the site and
# is the same file GitHub renders in the repository.
echo "==> adding the schema reference as the index"
python scripts/build_schema_docs.py --out "$PAGES/index.md" >/dev/null
# Its links point at repository paths, which do not exist inside the site.
python - "$PAGES/index.md" <<'PY'
import re
import sys
from pathlib import Path

page = Path(sys.argv[1])
repository = "https://github.com/MobilityData/gtfs-garage/blob/main"
page.write_text(
    re.sub(r"\]\(\.\./([^)]+)\)", rf"]({repository}/\1)", page.read_text(encoding="utf-8")),
    encoding="utf-8",
)
PY

cat > "$OUT/mkdocs.yml" <<'YAML'
site_name: GTFS schema
site_description: The files, fields and relationships GTFS defines.
theme:
  name: material
  features:
    - navigation.instant
    - search.highlight
markdown_extensions:
  - attr_list
  - footnotes
  - tables
  - pymdownx.superfences:
      custom_fences:
        - name: mermaid
          class: mermaid
          format: !!python/name:pymdownx.superfences.fence_code_format
plugins:
  - search
YAML

echo "==> building the site"
if [ "$SERVE" = true ]; then
    exec mkdocs serve -f "$OUT/mkdocs.yml"
fi

mkdocs build -f "$OUT/mkdocs.yml" -d "$PWD/$OUT/site" --strict 2>&1 | tail -5
echo "==> built $OUT/site"
