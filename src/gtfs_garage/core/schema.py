"""GTFS relational semantics: which columns are foreign keys, which column holds
a given entity's primary id, and which columns take a small fixed set of values
(so the UI can offer a picklist instead of a free-text box).

The data lives in data/gtfs-schema.json rather than in this module, so a
JavaScript/TypeScript viewer can consume exactly the same definitions instead of
keeping a second copy that drifts. It is read through importlib.resources so it
resolves correctly from an installed wheel, not just from a source checkout.
"""

from __future__ import annotations

import json
from importlib import resources
from typing import Any

SCHEMA_PACKAGE = "gtfs_garage.data"
SCHEMA_FILENAME = "gtfs-schema.json"


def load_schema() -> dict[str, Any]:
    """Read the packaged schema document."""
    source = resources.files(SCHEMA_PACKAGE).joinpath(SCHEMA_FILENAME)
    return json.loads(source.read_text(encoding="utf-8"))


_schema = load_schema()

# The document is keyed by table, then by field, so that per-field facts - a
# type, whether it is required - have somewhere to live as they are added. The
# lookups below flatten it into the shapes the query layer wants; adding a fact
# to a field changes nothing here.
TABLES: dict[str, dict[str, dict[str, Any]]] = {
    table: entry.get("fields", {}) for table, entry in _schema["tables"].items()
}


def _fields_where(predicate) -> dict[str, dict[str, Any]]:
    return {
        table: {column: field for column, field in fields.items() if predicate(field)}
        for table, fields in TABLES.items()
    }


# table -> { column: (referenced_table, referenced_column) }
FOREIGN_KEYS: dict[str, dict[str, tuple[str, str]]] = {
    table: {column: (field["references"]["table"], field["references"]["field"]) for column, field in fields.items()}
    for table, fields in _fields_where(lambda f: "references" in f).items()
    if fields
}

# table -> the column holding that entity's own id, used to find every other
# table that points back at a given row.
PRIMARY_ID_COLUMNS: dict[str, str] = {
    table: next(iter(fields)) for table, fields in _fields_where(lambda f: f.get("primaryKey")).items() if fields
}

ENUM_LIKE_COLUMNS: set[str] = set(_schema["enumLikeColumns"])

# GTFS field type -> what a value of it must look like: its description in the
# reference's own words, and where GTFS states a format, a `pattern` or a
# `minimum`/`maximum`. A field's "type" is the key. Empty for a document
# generated before field types were published.
FIELD_TYPES: dict[str, dict[str, Any]] = _schema.get("fieldTypes", {})


def value_shape(gtfs_type: str | None) -> dict[str, Any]:
    """What a value of a GTFS field type must look like, or an empty record.

    Empty for a column the schema does not describe, and for a type GTFS states
    no format for - `Email` excepted, whose pattern the schema owns and marks as
    its own. A caller can read the result without checking first.
    """
    return FIELD_TYPES.get(gtfs_type or "", {})


def field_info(table: str, column: str) -> dict[str, Any]:
    """What the schema says about one column, or an empty record.

    Empty for anything the schema does not describe - a producer's extension
    column, a file added to GTFS since this was last imported - so a caller can
    read it without checking first, and such a column simply renders untyped.
    """
    return TABLES.get(table, {}).get(column, {})


def related_tables(table: str) -> list[tuple[str, str]]:
    """Every (other_table, column) whose foreign key points at `table`'s primary
    id column - i.e. what to offer as "show related rows" links.
    """
    primary_column = PRIMARY_ID_COLUMNS.get(table)
    if primary_column is None:
        return []
    target = (table, primary_column)
    results = []
    for source_table, fk_columns in FOREIGN_KEYS.items():
        for source_column, ref in fk_columns.items():
            if ref == target and not (source_table == table and source_column == primary_column):
                results.append((source_table, source_column))
    return results
