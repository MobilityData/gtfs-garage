"""Response models.

These are the contract. FastAPI turns them into the OpenAPI document, and the
TypeScript `GtfsSource` interface in web/src/sources/types.ts mirrors them, so a
browser-side implementation reading Parquet can be substituted for the REST one
without the UI noticing. Changing a shape here is an interface change.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class RelatedLink(BaseModel):
    """A table that points back at the current row's id."""

    table: str
    column: str


class ColumnInfo(BaseModel):
    name: str
    # Set only when the referenced table and column exist in this feed.
    fk_table: str | None = None
    fk_column: str | None = None
    # True when GTFS defines a small fixed value set, so the UI offers a picklist.
    enum_like: bool = False
    # Always present; empty for columns that are not a table's primary id.
    related: list[RelatedLink] = []


class TableInfo(BaseModel):
    name: str
    row_count: int
    columns: list[ColumnInfo]


class TablesResponse(BaseModel):
    source: str
    tables: list[TableInfo]


class PageResponse(BaseModel):
    columns: list[str]
    # Row values are all strings or null: the loader reads every column as text
    # so a feed with malformed numbers still opens.
    rows: list[list[Any]]
    total: int
    page: int
    page_size: int


class ValueCount(BaseModel):
    # None means the value is empty in the feed.
    value: str | None = None
    count: int


class DistinctResponse(BaseModel):
    values: list[ValueCount]
