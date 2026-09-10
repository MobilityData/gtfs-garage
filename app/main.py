from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import geojson as geojson_builders
from app.filters import build_where
from app.gtfs_db import GtfsFeed, GtfsLoadError
from app.schema import ENUM_LIKE_COLUMNS, FOREIGN_KEYS, PRIMARY_ID_COLUMNS, related_tables

app = FastAPI(title="GTFS Garage")

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

_state: dict[str, object] = {"feed": None, "source": None}


def get_feed() -> GtfsFeed:
    feed = _state["feed"]
    if feed is None:
        raise HTTPException(status_code=409, detail="No GTFS feed loaded yet.")
    return feed  # type: ignore[return-value]


def _load(source: str) -> GtfsFeed:
    previous = _state["feed"]
    feed = GtfsFeed(source)  # raises GtfsLoadError on failure, leaving previous feed intact
    if previous is not None:
        previous.close()  # type: ignore[union-attr]
    _state["feed"] = feed
    _state["source"] = source
    return feed


def load_feed_from_path(path: str) -> None:
    """Used by the CLI entrypoint to load a feed at startup."""
    _load(path)


def _table_summaries(feed: GtfsFeed) -> list[dict]:
    summaries = []
    for table, columns in feed.tables.items():
        fk_map = FOREIGN_KEYS.get(table, {})
        primary_column = PRIMARY_ID_COLUMNS.get(table)
        column_infos = []
        # A link is only offered when its target actually exists in this feed -
        # GTFS files are largely optional, so e.g. routes -> fare_rules is a dead
        # end in a feed with no fare_rules.txt.
        def resolves(target_table: str, target_column: str) -> bool:
            return target_column in feed.tables.get(target_table, [])

        for column in columns:
            fk_table, fk_column = fk_map.get(column, (None, None))
            if fk_table and not resolves(fk_table, fk_column):
                fk_table, fk_column = None, None
            info = {
                "name": column,
                "fk_table": fk_table,
                "fk_column": fk_column,
                "enum_like": column in ENUM_LIKE_COLUMNS,
            }
            if column == primary_column:
                info["related"] = [
                    {"table": t, "column": c}
                    for t, c in related_tables(table)
                    if resolves(t, c)
                ]
            column_infos.append(info)
        summaries.append(
            {
                "name": table,
                "row_count": feed.row_count(table),
                "columns": column_infos,
            }
        )
    return summaries


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/api/load")
async def load_feed(file: Optional[UploadFile] = File(None), path: Optional[str] = None):
    if file is not None:
        tmp_dir = Path(tempfile.mkdtemp(prefix="gtfs-garage-upload-"))
        dest = tmp_dir / (file.filename or "feed.zip")
        with dest.open("wb") as out:
            shutil.copyfileobj(file.file, out)
        source = str(dest)
    elif path:
        source = path
    else:
        raise HTTPException(status_code=400, detail="Provide a file upload or a local path.")

    try:
        feed = _load(source)
    except GtfsLoadError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return {"source": source, "tables": _table_summaries(feed)}


@app.get("/api/tables")
def list_tables():
    feed = get_feed()
    return {"source": _state["source"], "tables": _table_summaries(feed)}


@app.get("/api/table/{table}")
def get_table(
    table: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    filters: str = "[]",
):
    feed = get_feed()
    if table not in feed.tables:
        raise HTTPException(status_code=404, detail=f"Unknown table '{table}'")
    columns = feed.tables[table]

    try:
        parsed_filters = json.loads(filters)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="filters must be valid JSON")

    where_sql, params = build_where(set(columns), parsed_filters)
    cur = feed.cursor()
    total = cur.execute(f'SELECT COUNT(*) FROM "{table}" {where_sql}', params).fetchone()[0]

    offset = (page - 1) * page_size
    col_list = ", ".join(f'"{c}"' for c in columns)
    rows = cur.execute(
        f'SELECT {col_list} FROM "{table}" {where_sql} LIMIT ? OFFSET ?',
        [*params, page_size, offset],
    ).fetchall()

    return {
        "columns": columns,
        "rows": rows,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@app.get("/api/table/{table}/distinct/{column}")
def distinct_values(table: str, column: str, limit: int = Query(200, le=2000)):
    feed = get_feed()
    if table not in feed.tables or column not in feed.tables[table]:
        raise HTTPException(status_code=404, detail="Unknown table or column")
    rows = feed.cursor().execute(
        f'SELECT "{column}", COUNT(*) FROM "{table}" GROUP BY "{column}" ORDER BY 2 DESC LIMIT ?',
        [limit],
    ).fetchall()
    return {"values": [{"value": v, "count": c} for v, c in rows]}


@app.get("/api/geojson/stops")
def stops_geojson(stop_ids: Optional[str] = None):
    feed = get_feed()
    ids = stop_ids.split(",") if stop_ids else None
    return geojson_builders.stops_geojson(feed.cursor(), ids)


@app.get("/api/geojson/shapes")
def shapes_geojson(shape_ids: Optional[str] = None):
    feed = get_feed()
    ids = shape_ids.split(",") if shape_ids else None
    return geojson_builders.shapes_geojson(feed.cursor(), ids)


@app.get("/api/geojson/routes")
def routes_geojson():
    feed = get_feed()
    return geojson_builders.routes_geojson(feed.con)
