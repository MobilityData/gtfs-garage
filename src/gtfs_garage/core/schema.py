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

# table -> { column: (referenced_table, referenced_column) }
FOREIGN_KEYS: dict[str, dict[str, tuple[str, str]]] = {
    table: {column: (ref["table"], ref["column"]) for column, ref in columns.items()}
    for table, columns in _schema["foreignKeys"].items()
}

# table -> the column holding that entity's own id, used to find every other
# table that points back at a given row.
PRIMARY_ID_COLUMNS: dict[str, str] = dict(_schema["primaryIdColumns"])

ENUM_LIKE_COLUMNS: set[str] = set(_schema["enumLikeColumns"])


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
