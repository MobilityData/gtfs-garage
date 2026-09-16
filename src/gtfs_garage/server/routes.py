"""HTTP layer: validates input, delegates to gtfs_garage.core, translates the
core's errors into status codes. No SQL here.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any, Optional

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse

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
    LoadProgressResponse,
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


@contextmanager
def _reading(request: Request) -> Iterator[GtfsFeed]:
    """Borrow the loaded feed for one request, keeping it alive while in use."""
    try:
        with _registry(request).reading() as feed:
            yield feed
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
        "convert_ms": stats.convert_ms,
        "count_ms": stats.count_ms,
        "total_ms": (acquire.ms if acquire else 0.0) + stats.total_ms,
        "total_bytes": stats.source_bytes,
        "stored_bytes": stats.stored_bytes,
        "files": [
            {
                "name": f.name,
                "table": f.table,
                "bytes": f.bytes,
                "compressed_bytes": f.compressed_bytes,
                "register_ms": f.register_ms,
                "convert_ms": f.convert_ms,
                "parquet_bytes": f.parquet_bytes,
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
def load_feed(
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
    registry.begin_load()

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
        registry.finish_load()
        raise HTTPException(status_code=400, detail=str(exc))
    except HTTPException:
        registry.finish_load()
        raise

    payload = _tables_payload(registry)
    registry.finish_load()
    return payload


@router.get("/load/progress", response_model=LoadProgressResponse)
def load_progress(request: Request) -> dict[str, Any]:
    """Where a running load has got to.

    Only answerable while a load is in flight because `load_feed` above is a
    plain `def` and so runs in a worker thread. As an `async def` it held the
    event loop for the whole load and nothing else could be served at all.
    """
    progress = _registry(request).progress
    return {
        "phase": progress.phase,
        "done": progress.done,
        "total": progress.total,
        "detail": progress.detail,
        "running": progress.running,
    }


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
        with _reading(request) as feed:
            return query_table(feed, table, parsed_filters, page, page_size)
    except UnknownTableError:
        raise HTTPException(status_code=404, detail=f"Unknown table '{table}'")


@router.get("/table/{table}/distinct/{column}", response_model=DistinctResponse)
def get_distinct_values(
    request: Request, table: str, column: str, limit: int = Query(200, ge=1, le=2000)
) -> dict[str, Any]:
    try:
        with _reading(request) as feed:
            return {"values": distinct_values(feed, table, column, limit)}
    except (UnknownTableError, UnknownColumnError):
        raise HTTPException(status_code=404, detail="Unknown table or column")


def _split_ids(ids: Optional[str]) -> Optional[list[str]]:
    return ids.split(",") if ids else None


def _ndjson(
    registry: FeedRegistry, count: Callable, batches: Callable, step: Callable | None = None
) -> StreamingResponse:
    """Stream a layer as newline-delimited JSON: a header, then feature batches.

    A whole-feed layer is far too large to build, hold and parse in one piece -
    a large feed runs to hundreds of MB - so it goes out as it is read. The
    header carries the total up front so the interface can show real progress,
    and DuckDB still scans the file only once, which paging with offsets would
    not have managed.

    The reader guard is held for the life of the generator, not just until this
    function returns: the cursor is still in use while the body streams, and a
    load arriving meanwhile would otherwise close the connection under it.
    """

    def stream() -> Iterator[bytes]:
        with registry.reading() as feed:
            cursor = feed.cursor()
            header = {"type": "header", "total": count(cursor), "step": step(cursor) if step else 1}
            yield (json.dumps(header) + "\n").encode()
            for batch in batches(cursor):
                yield (json.dumps({"type": "batch", "features": batch}, separators=(",", ":")) + "\n").encode()

    try:
        # Surfaces "no feed loaded" as a status code rather than mid-stream,
        # where the client would only see a truncated body.
        registry.current()
    except NoFeedLoadedError:
        raise HTTPException(status_code=409, detail="No GTFS feed loaded yet.")

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@router.get("/geojson/stops")
def stops_geojson(request: Request, stop_ids: Optional[str] = None):
    registry = _registry(request)
    if stop_ids:
        # A highlight asks for a handful of ids; small enough to answer whole.
        with registry.reading() as feed:
            return geojson_builders.stops_geojson(feed.cursor(), _split_ids(stop_ids))
    return _ndjson(registry, geojson_builders.count_stops, geojson_builders.iter_stops)


@router.get("/geojson/shapes")
def shapes_geojson(request: Request, shape_ids: Optional[str] = None):
    registry = _registry(request)
    if shape_ids:
        with registry.reading() as feed:
            return geojson_builders.shapes_geojson(feed.cursor(), _split_ids(shape_ids))
    return _ndjson(
        registry,
        geojson_builders.count_shapes,
        geojson_builders.iter_shapes,
        geojson_builders.shape_step,
    )


@router.get("/geojson/locations")
def locations_geojson(request: Request, location_ids: Optional[str] = None):
    registry = _registry(request)
    if location_ids:
        with registry.reading() as feed:
            return geojson_builders.locations_geojson(feed.cursor(), _split_ids(location_ids))
    # No step: zones are never thinned.
    return _ndjson(registry, geojson_builders.count_locations, geojson_builders.iter_locations)


@router.get("/geojson/routes")
def routes_geojson(request: Request):
    registry = _registry(request)
    return _ndjson(
        registry,
        geojson_builders.count_routes,
        geojson_builders.iter_routes,
        geojson_builders.shape_step,
    )
