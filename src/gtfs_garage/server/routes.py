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


def _tables_payload(registry: FeedRegistry) -> dict[str, Any]:
    return {"source": registry.source, "tables": table_summaries(registry.current())}


@router.get("/config", response_model=ConfigResponse)
def get_config(request: Request) -> dict[str, Any]:
    """Settings the interface reads before it builds the map."""
    return {"basemap": request.app.state.basemap, "version": __version__}


@router.post("/load", response_model=TablesResponse)
async def load_feed(
    request: Request,
    file: Optional[UploadFile] = File(None),
    path: Optional[str] = None,
) -> dict[str, Any]:
    registry = _registry(request)

    if file is not None:
        source = str(registry.store_upload(file.filename or "feed.zip", file.file))
    elif path:
        source = path
    else:
        raise HTTPException(status_code=400, detail="Provide a file upload or a local path.")

    try:
        registry.load(source)
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
