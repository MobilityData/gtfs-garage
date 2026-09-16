#!/usr/bin/env python
"""Generate the human-readable schema reference from the LinkML description.

`schema/gtfs.yaml` is the source of truth. This renders it as one Markdown file
with a Mermaid diagram, which GitHub displays directly - no site build, no
hosting, readable in a pull request diff.

It is built from the same resolved document that `build_schema_json.py` ships as
package data, so the reference and the packaged schema cannot disagree about a
type, a key or a foreign key.

Run after editing the LinkML:

    scripts/build-schema-docs.sh
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_schema_json import build  # noqa: E402  (needs the path above)

BANNER = "<!-- GENERATED from schema/gtfs.yaml by scripts/build_schema_docs.py. " "Edit the schema, not this file. -->"

INTRO = """\
# GTFS schema

{banner}

The GTFS schema used in this project is based on the [official GTFS Schedule Reference](https://gtfs.org/documentation/schedule/reference/).
This document and the schema files included in this project are **not intended to be the source of truth for the GTFS specification**.
They are maintained to support this project in formatting and validating GTFS datasets.
This documentation describes the {table_count} files defined by GTFS and the {field_count} fields they contain, including each field's data type, whether it is required, and any references to fields in other files.
The machine-readable version is [`gtfs-schema.json`](../src/gtfs_garage/data/gtfs-schema.json), which is included in the package. Both this documentation and the JSON schema are generated from [`schema/gtfs.yaml`](../schema/gtfs.yaml).
"""

DIAGRAM_NOTE = """\
Each box is a file, keyed by its primary key. An arrow runs from the file that
holds the reference to the file it points at, labelled with the field carrying
it. A solid end means the reference is required, an open one that it is optional.

{unshown}
"""


def cell(text: str) -> str:
    """Make a string safe inside a Markdown table cell.

    Descriptions come from the schema, where a pipe or a line break is allowed
    and would otherwise split the row into the wrong number of columns.
    """
    return " ".join(str(text).split()).replace("|", "\\|")


def relationship(required: bool) -> str:
    """Mermaid cardinality: many rows here, one row there, optionally."""
    return "}o--||" if required else "}o--o|"


def primary_keys(table: dict) -> list[str]:
    return [name for name, field in table["fields"].items() if field.get("primaryKey")]


def diagram(document: dict) -> tuple[str, list[str]]:
    """The entity diagram, and the references it could not draw.

    Only primary keys are drawn inside the boxes. Every field of all 31 files at
    once is unreadable, and the field tables below carry that detail anyway.
    """
    lines = ["erDiagram"]

    for name, table in document["tables"].items():
        keys = primary_keys(table)
        if not keys:
            # A bare name, not an empty block: the files GTFS gives no key are
            # still worth drawing, and `{ }` is not accepted everywhere.
            lines.append(f"    {name}")
            continue
        lines.append(f"    {name} {{")
        for key in keys:
            field_type = table["fields"][key].get("type", "Text")
            lines.append(f"        {field_type} {key} PK")
        lines.append("    }")

    unshown: list[str] = []
    for name, table in document["tables"].items():
        for field_name, field in table["fields"].items():
            reference = field.get("references")
            if not reference:
                continue
            if reference["table"] not in document["tables"]:
                unshown.append(f"`{name}.{field_name}` points at `{reference['table']}`")
                continue
            arrow = relationship(field.get("required") == "always")
            lines.append(f'    {name} {arrow} {reference["table"]} : "{field_name}"')

    return "\n".join(lines), unshown


# A condition that reaches outside the row it governs is footnoted with what it
# reaches for: the condition alone reads as though a row could settle it.
CONDITION_SCOPE_MARKERS = {"feed": "[^feed]", "row_context": "[^rowcontext]"}

CONDITION_SCOPE_NOTES = {
    "feed": (
        "[^feed]: Answered by the feed as a whole rather than by any single row, so "
        "it can be settled once for a whole column. `gtfs-schema.json` carries the "
        "check to run as a `conditionCheck` record - a `kind` naming the sort of "
        "question, plus its arguments."
    ),
    "row_context": (
        "[^rowcontext]: Settled row by row, but not by the row alone - it turns "
        "on the row's position among its siblings, or on rows in another file."
    ),
}


def requirement(field: dict) -> str:
    required = field.get("required")
    if required == "always":
        return "**Required**"
    if required == "conditional":
        note = field.get("condition") or "see GTFS"
        marker = CONDITION_SCOPE_MARKERS.get(field.get("conditionScope"), "")
        return f"Conditional{marker} — {note}"
    if required:
        return required.replace("_", " ").capitalize()
    return "Optional"


def field_notes(field: dict) -> str:
    notes = []
    if field.get("primaryKey"):
        notes.append("primary key")
    reference = field.get("references")
    if reference:
        notes.append(f"→ `{reference['table']}.{reference['field']}`")
    values = field.get("values")
    if values:
        shown = ", ".join(f"`{code}` {title}" for code, title in list(values.items())[:4])
        if len(values) > 4:
            shown += f", … ({len(values)} values)"
        notes.append(shown)
    return "; ".join(notes)


def file_section(name: str, table: dict, description: str) -> str:
    lines = [f"### `{name}.txt`", ""]
    if description:
        lines += [description, ""]

    lines += ["| Field | Type | Required | Notes |", "|---|---|---|---|"]
    for field_name, field in table["fields"].items():
        lines.append(
            f"| `{field_name}` "
            f"| {cell(field.get('type', ''))} "
            f"| {cell(requirement(field))} "
            f"| {cell(field_notes(field))} |"
        )
    lines.append("")
    return "\n".join(lines)


def render(document: dict, schema: dict) -> str:
    classes = schema.get("classes") or {}
    field_count = sum(len(table["fields"]) for table in document["tables"].values())

    mermaid, unshown = diagram(document)
    unshown_note = ""
    if unshown:
        unshown_note = "Not drawn, because the target is not keyed on a single field: " + "; ".join(unshown) + "."

    parts = [
        INTRO.format(
            banner=BANNER,
            table_count=len(document["tables"]),
            field_count=field_count,
        ),
        "## How the files relate",
        "",
        "```mermaid",
        mermaid,
        "```",
        "",
        DIAGRAM_NOTE.format(unshown=unshown_note).rstrip(),
        "",
        "## Files",
        "",
    ]

    for name, table in document["tables"].items():
        description = (classes.get(name) or {}).get("description") or ""
        parts.append(file_section(name, table, description))

    scopes = {
        field.get("conditionScope") for table in document["tables"].values() for field in table["fields"].values()
    }
    for scope, note in CONDITION_SCOPE_NOTES.items():
        if scope in scopes:
            parts.extend([note, ""])

    return "\n".join(parts)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schema", default="schema/gtfs.yaml")
    parser.add_argument("--out", default="docs/SCHEMA.md")
    args = parser.parse_args(argv)

    schema = yaml.safe_load(Path(args.schema).read_text(encoding="utf-8"))
    document = build(schema)

    Path(args.out).write_text(render(document, schema), encoding="utf-8")

    references = sum(
        1 for table in document["tables"].values() for field in table["fields"].values() if field.get("references")
    )
    print(
        f"wrote {args.out}: {len(document['tables'])} files, "
        f"{sum(len(t['fields']) for t in document['tables'].values())} fields, "
        f"{references} references"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
