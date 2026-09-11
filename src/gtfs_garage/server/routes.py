"""HTTP layer: validates input, delegates to gtfs_garage.core, translates the
core's errors into status codes. No SQL here.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile

from gtfs_garage import __version__
from gtfs_garage.core import geojson as geojson_builders
from gtfs_garage.core.feed import GtfsFeed, GtfsLoadError
from gtfs_garage.core.queries import (
    UnknownColumnError,
    UnknownTableError,
    distinct_values,
    query_table,
    table_summaries,
)
from gtfs_garage.server.models import (
    ConfigResponse,
    DistinctResponse,
    PageResponse,
    TablesResponse,
)
from gtfs_garage.server.state import FeedRegistry, NoFeedLoadedError

router = APIRouter(prefix="/api")


def _registry(request: Request) -> FeedRegistry:
    return request.app.state.feeds


def _feed(request: Request) -> GtfsFeed:
    try:
        return _registry(request).current()
    except NoFeedLoadedError:
        raise HTTPException(status_code=409, detail="No GTFS feed loaded yet.")


def _load_metrics(registry: FeedRegistry) -> dict[str, Any]:
    """Sizes and timings for the load that produced the feed being served.

    Read after `table_summaries`, not before: the per-file counting times are
    filled in by that pass, which is the only point a CSV is really read.
    """
    record = registry.last_load
    stats = record.feed_stats
    acquire = record.acquire
    return {
        "kind": record.kind,
        "acquire_ms": acquire.ms if acquire else None,
        "acquire_bytes": acquire.bytes if acquire else None,
        "extract_ms": stats.extract_ms,
        "register_ms": stats.register_ms,
        "count_ms": stats.count_ms,
        "total_ms": (acquire.ms if acquire else 0.0) + stats.total_ms,
        "total_bytes": stats.source_bytes,
        "files": [
            {
                "name": f.name,
                "table": f.table,
                "bytes": f.bytes,
                "compressed_bytes": f.compressed_bytes,
                "register_ms": f.register_ms,
                "count_ms": f.count_ms,
                "row_count": f.row_count,
                "columns": f.columns,
            }
            for f in stats.files
        ],
    }


def _tables_payload(registry: FeedRegistry) -> dict[str, Any]:
    summaries = table_summaries(registry.current())
    return {"source": registry.source, "tables": summaries, "metrics": _load_metrics(registry)}


@router.get("/config", response_model=ConfigResponse)
def get_config(request: Request) -> dict[str, Any]:
    """Settings the interface reads before it builds the map."""
    return {"basemap": request.app.state.basemap, "version": __version__}


@router.post("/load", response_model=TablesResponse)
async def load_feed(
    request: Request,
    file: Optional[UploadFile] = File(None),
    files: list[UploadFile] = File([]),
    path: Optional[str] = None,
    url: Optional[str] = None,
    name: Optional[str] = None,
) -> dict[str, Any]:
    """Open a feed from an upload, a chosen folder, a local path, or a URL.

    `files` carries a folder the browser has split into its individual files;
    `name` is the folder's own name, for display.
    """
    registry = _registry(request)

    try:
        if files:
            source = str(registry.store_upload_folder((f.filename or "", f.file) for f in files))
            label = name or "chosen folder"
        elif file is not None:
            filename = file.filename or "feed.zip"
            source, label = str(registry.store_upload(filename, file.file)), filename
        elif url:
            source, label = str(registry.store_download(url)), url
        elif path:
            source = label = path
        else:
            raise HTTPException(status_code=400, detail="Provide a file upload, a local path, or a URL.")

        registry.load(source, label)
    except GtfsLoadError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return _tables_payload(registry)


@router.get("/tables", response_model=TablesResponse)
def list_tables(request: Request) -> dict[str, Any]:
    registry = _registry(request)
    _feed(request)  # 409 when nothing is loaded
    return _tables_payload(registry)


@router.get("/table/{table}", response_model=PageResponse)
def get_table(
    request: Request,
    table: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=500),
    filters: str = "[]",
) -> dict[str, Any]:
    try:
        parsed_filters = json.loads(filters)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="filters must be valid JSON")
    if not isinstance(parsed_filters, list):
        raise HTTPException(status_code=400, detail="filters must be a JSON array")

    try:
        return query_table(_feed(request), table, parsed_filters, page, page_size)
    except UnknownTableError:
        raise HTTPException(status_code=404, detail=f"Unknown table '{table}'")


@router.get("/table/{table}/distinct/{column}", response_model=DistinctResponse)
def get_distinct_values(
    request: Request, table: str, column: str, limit: int = Query(200, ge=1, le=2000)
) -> dict[str, Any]:
    try:
        return {"values": distinct_values(_feed(request), table, column, limit)}
    except (UnknownTableError, UnknownColumnError):
        raise HTTPException(status_code=404, detail="Unknown table or column")


def _split_ids(ids: Optional[str]) -> Optional[list[str]]:
    return ids.split(",") if ids else None


@router.get("/geojson/stops")
def stops_geojson(request: Request, stop_ids: Optional[str] = None) -> dict[str, Any]:
    return geojson_builders.stops_geojson(_feed(request).cursor(), _split_ids(stop_ids))


@router.get("/geojson/shapes")
def shapes_geojson(request: Request, shape_ids: Optional[str] = None) -> dict[str, Any]:
    return geojson_builders.shapes_geojson(_feed(request).cursor(), _split_ids(shape_ids))


@router.get("/geojson/routes")
def routes_geojson(request: Request) -> dict[str, Any]:
    return geojson_builders.routes_geojson(_feed(request).cursor())
