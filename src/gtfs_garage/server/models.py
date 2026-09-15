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
    # What GTFS says this field holds - ID, ENUM, COLOR, LATITUDE, DATE and so
    # on - used to format the value. Null for a column the schema does not
    # describe, such as a producer's own extension, which renders as text.
    type: str | None = None
    # For an enumeration, its codes and their labels; null otherwise.
    values: dict[str, str] | None = None
    # "always", "conditional", or null where GTFS makes the field optional.
    required: str | None = None
    # For a conditionally required field, the condition in words, so the UI can
    # explain it. Null otherwise.
    condition: str | None = None


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
    # Declaring the DuckDB view, which resolves the column list off the start
    # of the file and reads no further - so this barely varies with size. The
    # interface labels it "read headers", which is what it amounts to.
    register_ms: float
    # Rewriting this table as Parquet; null when opened with --no-parquet.
    convert_ms: float | None = None
    # What the table occupies once converted, typically far below `bytes`.
    parquet_bytes: int | None = None
    # The COUNT(*) that reads the file end to end. The cost that scales.
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
    # Converting to Parquet; null when opened with --no-parquet.
    convert_ms: float | None = None
    count_ms: float
    # The phases above added together.
    total_ms: float
    # The zip's size, or the sum of the .txt files in a folder.
    total_bytes: int
    # What the feed occupies to query once converted; null when it was not.
    stored_bytes: int | None = None
    files: list[FileMetrics]


class LoadProgressResponse(BaseModel):
    """Where a running load has got to, polled while the load is in flight."""

    # start | download | upload | extract | convert | summarise | done
    phase: str
    done: int
    # 0 when the total is not knowable, e.g. a download with no Content-Length.
    total: int
    # The file or table currently being worked on, when there is one.
    detail: str
    running: bool


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
