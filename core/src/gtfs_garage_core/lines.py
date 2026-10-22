"""The line a row was read from, counted the way gtfs-validator counts it.

A validator report locates most of its findings by `csvRowNumber`: the physical
line of the file on which the record *ends*, with the header as line 1. That
was checked against gtfs-validator 8.0.1 rather than assumed - a record whose
quoted value spans lines 2 to 4 is reported as row 4, and the records after it
by their own line numbers.

For an ordinary file that is the record's position plus two, and Parquet keeps
the position for free: DuckDB preserves a CSV's record order through its
parallel reader and through `COPY`, so `read_parquet(..., file_row_number=true)`
answers it with no column stored at all. Three things break that arithmetic:

- a quoted value with a newline inside it, which makes one record span lines;
- a row with too few or too many fields, which `IGNORE_ERRORS` drops;
- a blank line, which DuckDB skips.

None of these can be seen from inside DuckDB once it has read the file, so the
loader compares the file's physical line count with the rows it kept. When they
agree the position is exact. When they do not, the file is read once more here,
with Python's own CSV reader, keeping exactly the records DuckDB kept, and the
line of each is stored as a column. That pass only runs on a file that needs it,
which in practice means a feed the validator already flags.
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

# The reserved column. A leading underscore because GTFS defines no field that
# starts with one, so it cannot collide with a column a feed actually has.
LINE_COLUMN = "_line"

# What a table's line numbers can be trusted for.
EXACT = "exact"
APPROXIMATE = "approximate"

# How a table's line numbers are produced.
BY_POSITION = "position"  # file_row_number + 2, nothing stored
BY_COLUMN = "column"  # a stored `_line`
BY_WINDOW = "window"  # row_number() over a CSV view, --no-parquet

# Above this many rows the Python pass is skipped: it reads about a million rows
# a second, and a load should not stall for a minute to number a broken file.
# Such a table is marked approximate instead, which the interface says.
SLOW_PATH_ROW_LIMIT = 5_000_000

_CHUNK = 16 * 1024 * 1024


def physical_lines(path: Path) -> int:
    """How many lines the file has, not counting newlines at its very end.

    A file ending in a newline - which most do - has as many lines as newline
    characters; one that does not has one more. Trailing blank lines are not
    content, and counting them would make every such file look broken.
    """
    newlines = 0
    trailing = 0  # newlines at the end of what has been read so far
    seen_content = False
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK):
            newlines += chunk.count(b"\n")
            stripped = chunk.rstrip(b"\r\n")
            if stripped:
                seen_content = True
                trailing = chunk[len(stripped) :].count(b"\n")
            else:
                trailing += chunk.count(b"\n")
    if not seen_content:
        return 0
    return newlines - trailing + 1


def kept_record_lines(path: Path) -> list[int] | None:
    """The end line of every record DuckDB keeps, in order.

    Mirrors the reader the loader uses: RFC 4180 quoting with `"` as both quote
    and escape, a header naming the columns, blank lines skipped, and a record
    with a different number of fields from the header dropped - which is what
    `IGNORE_ERRORS` does with one. `line_num` is the number of physical lines
    consumed so far, which after reading a record is the line it ends on.

    Returns None when the file cannot be read this way at all.
    """
    csv.field_size_limit(sys.maxsize)
    lines: list[int] = []
    try:
        with path.open(encoding="utf-8-sig", errors="replace", newline="") as handle:
            reader = csv.reader(handle, delimiter=",", quotechar='"', doublequote=True, strict=False)
            header = next(reader, None)
            if header is None:
                return []
            width = len(header)
            for record in reader:
                if not record or record == [""] and width != 1:
                    continue
                if len(record) != width:
                    continue
                lines.append(reader.line_num)
    except (OSError, csv.Error):
        return None
    return lines
