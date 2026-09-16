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


class ImpliedValue(BaseModel):
    """What GTFS says an empty value means for this field.

    `code` is one of the field's own enum codes - "0 or empty - Regularly
    scheduled pickup" - and is absent only where the implied meaning has no
    code, as for fare_attributes.transfers, whose empty value means unlimited
    transfers.
    """

    code: str | None = None
    label: str


class ConditionOutcome(BaseModel):
    """Whether a feed-scope condition holds in the feed now loaded.

    `evidence` is what the check counted to decide - "3 agencies" - so a reader
    can see the answer's basis instead of being asked to trust it.
    """

    holds: bool
    evidence: str


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
    # What decides the condition: "row" where the row settles it, "feed" where
    # the feed as a whole does, "row_context" where it varies row by row and the
    # row does not carry what decides it. Null unless the field is conditional.
    condition_scope: str | None = None
    # The answer for this feed, for a "feed" scope. Null for any other scope,
    # and null when the check could not run - a resolved answer is only ever
    # present when one was actually computed.
    condition_outcome: ConditionOutcome | None = None
    # What an empty value implies, where GTFS defines it. Null otherwise.
    when_empty: ImpliedValue | None = None
    # What a value of this field's type must look like, from the schema's
    # `fieldTypes`. The rule lives there so the UI does not keep a second copy;
    # all four are null for a type GTFS states no format for.
    pattern: str | None = None
    minimum: float | None = None
    maximum: float | None = None
    # GTFS's own definition of the type, shown when a value does not match and
    # the UI has no shorter wording of its own.
    type_description: str | None = None


class MissingFile(BaseModel):
    """A file the feed does not have and needs.

    Only files GTFS requires, or conditionally requires with the condition
    holding for this feed. A feed is normally without twenty optional files, and
    reporting those would bury the ones that matter.
    """

    name: str
    # "required" or "conditional".
    presence: str
    # For a conditional file, the condition in words. Null for a required one,
    # which needs no explanation.
    condition: str | None = None
    # Why the condition holds here - "calendar_dates is absent".
    condition_outcome: ConditionOutcome | None = None


class FileCondition(BaseModel):
    """Why GTFS says this feed should not contain this file.

    The counterpart to `MissingFile`: that one is absent and needed, this one is
    present and not wanted, which is a fact about a table the feed has.
    """

    condition: str
    outcome: ConditionOutcome


class TableInfo(BaseModel):
    name: str
    row_count: int
    columns: list[ColumnInfo]
    # Set only where GTFS forbids this file and the condition holds here.
    forbidden: FileCondition | None = None


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
    # Files absent from this feed that GTFS says it needs. Empty for a complete
    # feed, which is the usual case.
    missing: list[MissingFile] = []
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
