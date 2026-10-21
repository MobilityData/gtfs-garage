"""Turns structured filters built by the UI (column + operator + value) into a
parameterized SQL WHERE clause. Values are always bound as parameters; column
names are only ever taken from a table's already-introspected column list
(the caller must check membership before calling this), so identifiers are
never built from arbitrary user input.
"""

from __future__ import annotations

OPERATORS = {"eq", "ne", "contains", "is_empty", "is_not_empty", "in"}


def build_where(known_columns: set[str], filters: list[dict]) -> tuple[str, list]:
    clauses: list[str] = []
    params: list = []

    for f in filters:
        column = f.get("column")
        op = f.get("op")
        value = f.get("value")

        if column not in known_columns or op not in OPERATORS:
            continue

        col = f'"{column}"'

        # An empty CSV field loads as NULL, so "= (empty)" has to mean "is empty"
        # or picking the "(empty)" entry out of a value picklist matches nothing.
        if op == "eq" and value in (None, ""):
            op = "is_empty"
        elif op == "ne" and value in (None, ""):
            op = "is_not_empty"

        if op == "eq":
            clauses.append(f"{col} = ?")
            params.append(value)
        elif op == "ne":
            clauses.append(f"{col} != ?")
            params.append(value)
        elif op == "contains":
            clauses.append(f"{col} ILIKE ?")
            params.append(f"%{value}%")
        elif op == "is_empty":
            clauses.append(f"({col} IS NULL OR {col} = '')")
        elif op == "is_not_empty":
            clauses.append(f"({col} IS NOT NULL AND {col} != '')")
        elif op == "in":
            values = [v.strip() for v in str(value).split(",") if v.strip() != ""]
            if not values:
                continue
            placeholders = ", ".join(["?"] * len(values))
            clauses.append(f"{col} IN ({placeholders})")
            params.extend(values)

    if not clauses:
        return "", []
    return "WHERE " + " AND ".join(clauses), params
