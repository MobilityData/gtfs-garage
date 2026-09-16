"""Reads over a loaded feed: what tables it has and how they link, a page of
rows, and the distinct values of a column.

This is where the SQL lives. The web layer passes plain arguments in and gets
plain dictionaries back, so it never holds a database cursor of its own.
"""

from __future__ import annotations

import time
from typing import Any

from gtfs_garage.core.conditions import evaluate
from gtfs_garage.core.feed import GtfsFeed
from gtfs_garage.core.filters import build_where
from gtfs_garage.core.schema import (
    ENUM_LIKE_COLUMNS,
    FOREIGN_KEYS,
    PRIMARY_ID_COLUMNS,
    field_info,
    related_tables,
    value_shape,
)


class UnknownTableError(LookupError):
    """The feed has no table by that name."""


class UnknownColumnError(LookupError):
    """The table has no column by that name."""


def _require_table(feed: GtfsFeed, table: str) -> list[str]:
    columns = feed.tables.get(table)
    if columns is None:
        raise UnknownTableError(table)
    return columns


def table_summaries(feed: GtfsFeed) -> list[dict[str, Any]]:
    """Every table in the feed with its row count and per-column link metadata.

    A link is only offered when its target exists in *this* feed - GTFS files
    are largely optional, so e.g. routes -> fare_rules is a dead end in a feed
    with no fare_rules.txt.
    """

    def resolves(target_table: str, target_column: str) -> bool:
        return target_column in feed.tables.get(target_table, [])

    # Keyed on the check itself, so the three agency_id columns - which declare
    # the same one - read agency.txt once between them rather than each.
    answered: dict[tuple, tuple[bool, str] | None] = {}

    def outcome(check: dict[str, Any] | None) -> dict[str, Any] | None:
        """Whether a feed-scope condition holds here, or None if unanswerable."""
        if not check:
            return None
        key = tuple(sorted(check.items()))
        if key not in answered:
            answered[key] = evaluate(feed, check)
        result = answered[key]
        return None if result is None else {"holds": result[0], "evidence": result[1]}

    summaries = []
    for table, columns in feed.tables.items():
        fk_map = FOREIGN_KEYS.get(table, {})
        primary_column = PRIMARY_ID_COLUMNS.get(table)

        column_infos = []
        for column in columns:
            fk_table, fk_column = fk_map.get(column, (None, None))
            if fk_table and not resolves(fk_table, fk_column):
                fk_table, fk_column = None, None

            related = []
            if column == primary_column:
                related = [{"table": t, "column": c} for t, c in related_tables(table) if resolves(t, c)]

            # The schema is already loaded; this is the same lookup as the
            # foreign key above, returning what the interface needs to render a
            # value rather than only to link it.
            described = field_info(table, column)
            # Stated once per type in the document and flattened onto the column
            # here, as the enum's values are: the UI reads one record per column
            # rather than carrying a second lookup table.
            shape = value_shape(described.get("type"))

            column_infos.append(
                {
                    "name": column,
                    "fk_table": fk_table,
                    "fk_column": fk_column,
                    "enum_like": column in ENUM_LIKE_COLUMNS,
                    "related": related,
                    "type": described.get("type"),
                    "values": described.get("values"),
                    "required": described.get("required"),
                    "condition": described.get("condition"),
                    "condition_scope": described.get("conditionScope"),
                    "condition_outcome": outcome(described.get("conditionCheck")),
                    "when_empty": described.get("whenEmpty"),
                    "pattern": shape.get("pattern"),
                    "minimum": shape.get("minimum"),
                    "maximum": shape.get("maximum"),
                    "type_description": shape.get("description"),
                }
            )

        # The COUNT(*) is where a CSV is genuinely read - the views themselves
        # are lazy - so this is the timing worth recording per file.
        started = time.perf_counter()
        row_count = feed.row_count(table)
        feed.stats.record_count(table, row_count, (time.perf_counter() - started) * 1000)

        summaries.append({"name": table, "row_count": row_count, "columns": column_infos})
    return summaries


def query_table(
    feed: GtfsFeed,
    table: str,
    filters: list[dict[str, Any]] | None = None,
    page: int = 1,
    page_size: int = 100,
) -> dict[str, Any]:
    """One page of rows, with the total matching count for the pager."""
    columns = _require_table(feed, table)
    where_sql, params = build_where(set(columns), filters or [])

    cursor = feed.cursor()
    total = cursor.execute(f'SELECT COUNT(*) FROM "{table}" {where_sql}', params).fetchone()[0]

    column_list = ", ".join(f'"{c}"' for c in columns)
    offset = (page - 1) * page_size
    rows = cursor.execute(
        f'SELECT {column_list} FROM "{table}" {where_sql} LIMIT ? OFFSET ?',
        [*params, page_size, offset],
    ).fetchall()

    return {
        "columns": columns,
        "rows": [list(row) for row in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


def distinct_values(feed: GtfsFeed, table: str, column: str, limit: int = 200) -> list[dict[str, Any]]:
    """Distinct values of a column with their counts, most common first.

    Empty CSV fields load as NULL, so a value of None here means "empty" - the
    filter layer treats `= (empty)` as a null-or-empty test to match.
    """
    columns = _require_table(feed, table)
    if column not in columns:
        raise UnknownColumnError(column)

    rows = (
        feed.cursor()
        .execute(
            f'SELECT "{column}", COUNT(*) FROM "{table}" GROUP BY "{column}" ORDER BY 2 DESC LIMIT ?',
            [limit],
        )
        .fetchall()
    )
    return [{"value": value, "count": count} for value, count in rows]
