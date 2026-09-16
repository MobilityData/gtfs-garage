"""Conditions GTFS states that no single row can settle.

Most of GTFS's conditional requirements turn on the row they govern - "required
if route_long_name is empty" - and the schema carries those as LinkML rules. A
few turn on the feed instead: `agency_id` is required "when the feed contains
more than one agency", which is a question about agency.txt rather than about
the row in front of you.

The same is true one level up: whether a feed must contain calendar.txt depends
on whether it contains calendar_dates.txt.

Fields and files alike carry `conditionScope: "feed"` and a `conditionCheck`
saying what to look at:

    {"kind": "row_count", "file": "agency", "minimum": 2}

The kind is the vocabulary, the rest are its arguments. That matters because the
schema document is published for other projects to read: a consumer implements
`row_count` once and can then answer every field that uses it, in any language,
without this module.

Nothing here reports a violation. The answer is what GTFS requires *of this
feed*, not whether the feed complies - checking compliance is gtfs-validator's
job, and a second, weaker validator inside a viewer would help nobody.
"""

from __future__ import annotations

from collections.abc import Callable

from gtfs_garage.core.feed import GtfsFeed

# Whether the condition holds, and what was counted to decide it.
Outcome = tuple[bool, str]


def _row_count(feed: GtfsFeed, check: dict) -> Outcome | None:
    """Holds when a file carries at least `minimum` rows."""
    table, minimum = check.get("file"), check.get("minimum")
    # The generator rejects an incomplete check, so this guards only against a
    # document written by a later release whose arguments have moved on.
    if table is None or minimum is None or table not in feed.tables:
        return None
    count = feed.row_count(table)
    return count >= minimum, f"{table}.txt has {count} {'row' if count == 1 else 'rows'}"


def _file_present(feed: GtfsFeed, check: dict) -> Outcome | None:
    """Holds when the feed contains a file."""
    table = check.get("file")
    if table is None:
        return None
    present = table in feed.tables
    # The state rather than the verdict, so the same sentence explains both this
    # kind and its opposite.
    return present, f"{table} is {'present' if present else 'absent'}"


def _file_absent(feed: GtfsFeed, check: dict) -> Outcome | None:
    """Holds when the feed does not contain a file."""
    outcome = _file_present(feed, check)
    return None if outcome is None else (not outcome[0], outcome[1])


def _column_present(feed: GtfsFeed, check: dict) -> Outcome | None:
    """Holds when a file carries a column."""
    table, column = check.get("file"), check.get("column")
    if table is None or column is None or table not in feed.tables:
        return None
    present = column in feed.tables[table]
    return present, f"{table}.{column} is {'present' if present else 'absent'}"


def _rows_match(feed: GtfsFeed, check: dict) -> Outcome | None:
    """Holds when a file has at least one row whose column equals a value.

    The first check that reads row data rather than the file list. It runs only
    where the condition is still open - a feed that already has levels.txt is
    never asked whether it needs one - and the files these conditions name are
    small.
    """
    table, column, value = check.get("file"), check.get("column"), check.get("equals")
    if table is None or column is None or value is None:
        return None
    if column not in feed.tables.get(table, []):
        return None

    # The value is a parameter; the identifiers come from the schema and are
    # quoted the way every other query in this package quotes them.
    count = feed.cursor().execute(f'SELECT COUNT(*) FROM "{table}" WHERE "{column}" = ?', [value]).fetchone()[0]
    return count > 0, f"{table} has {count} {'row' if count == 1 else 'rows'} with {column}={value}"


CHECK_KINDS: dict[str, Callable[[GtfsFeed, dict], Outcome | None]] = {
    "row_count": _row_count,
    "file_present": _file_present,
    "file_absent": _file_absent,
    "column_present": _column_present,
    "rows_match": _rows_match,
}


def evaluate(feed: GtfsFeed, check: dict | None) -> Outcome | None:
    """Answer one condition for this feed, or None where it cannot be answered.

    None when the feed lacks the file the check reads. GTFS files are largely
    optional and a feed can be partial, so an unanswerable condition is ordinary
    rather than an error - the caller falls back to stating the condition in
    words, which is all it could do before any of this existed.

    An unrecognised kind is ignored for the same reason: gtfs-schema.json ships
    in the wheel and is consumed by other projects, so it can be newer than the
    Python next to it and describe a kind this build cannot carry out.
    """
    if not check:
        return None
    implementation = CHECK_KINDS.get(check.get("kind"))
    return implementation(feed, check) if implementation else None
