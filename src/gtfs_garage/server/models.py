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


class FileMetrics(BaseModel):
    """What one .txt file cost to open."""

    name: str
    table: str
    # Uncompressed size on disk.
    bytes: int
    # Only for zip sources; a chosen folder has no compressed form.
    compressed_bytes: int | None = None
    # Declaring the DuckDB view. Views are lazy, so this is near zero by
    # design - it is not where a slow feed spends its time.
    register_ms: float
    # The COUNT(*) that actually scans the file. This is the real read cost.
    count_ms: float | None = None
    row_count: int | None = None
    columns: int


class LoadMetrics(BaseModel):
    """Server-side sizes and timings for the feed currently loaded."""

    # path | upload | folder | download - how the feed reached the server.
    kind: str
    # Downloading or receiving the upload; absent for a local path.
    acquire_ms: float | None = None
    acquire_bytes: int | None = None
    # Unzipping; absent when the source was already-extracted files.
    extract_ms: float | None = None
    register_ms: float
    count_ms: float
    # The phases above added together.
    total_ms: float
    # The zip's size, or the sum of the .txt files in a folder.
    total_bytes: int
    files: list[FileMetrics]


class TablesResponse(BaseModel):
    source: str
    tables: list[TableInfo]
    metrics: LoadMetrics


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


class ConfigResponse(BaseModel):
    """Settings the interface reads at startup."""

    # A preset name ("openfreemap", "esri", "osm", "carto", "none"), a raster
    # tile template, or a vector style URL. The frontend resolves it.
    basemap: str
    version: str
