"""Builds GeoJSON for the map view directly from the DuckDB views - no separate
export step, so it stays correct for whatever feed is currently loaded.

Two shapes of API here. The `*_geojson` functions build one FeatureCollection
and are used for the small, id-filtered highlight requests. The `iter_*`
generators yield batches instead, so a national feed - half a million stops and
ten million shape vertices - reaches the browser as it is read rather than
after a complete collection has been built in memory on both ends.
"""

from __future__ import annotations

from collections.abc import Iterator

# Batches are a compromise: large enough that per-batch overhead disappears,
# small enough that the map redraws while the rest is still arriving.
BATCH_SIZE = 5000

# Metres-per-degree means the sixth decimal is about 10 cm. Five is more than a
# map needs, and dropping the rest is most of the payload on a dense feed.
COORD_PRECISION = 5

# Most shape vertices the map may hold in total, a vertex being one row of
# shapes.txt. At or below this the feed is drawn exactly; above it, every
# `ceil(rows / MAX_MAP_VERTICES)`-th point of each line is kept. So a feed whose
# shapes.txt has a million rows or fewer is untouched, two million loses every
# other point, ten million keeps one in ten. Shapes themselves are never
# dropped, and the stops layer is never thinned at all.
#
# One budget for the map rather than one per layer: the routes and shapes
# layers are both drawn from shapes.txt into the same browser heap, so budgeting
# them separately quietly allowed twice this number. docs/ARCHITECTURE.md
# tabulates the behaviour.
#
# The ceiling is what a browser survives rather than a preference. Measured on a
# 4.5 GB national feed: every vertex crashes the tab outright, and with the whole
# map drawn the tab peaks near a gigabyte of JS heap - close enough to the limit
# that opening a table afterwards was enough to kill it. Re-measure before
# raising it.
MAX_MAP_VERTICES = 600_000


def _to_float(value) -> float | None:
    try:
        if value in (None, ""):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _point(lon: float, lat: float) -> list[float]:
    return [round(lon, COORD_PRECISION), round(lat, COORD_PRECISION)]


def _stop_feature(row) -> dict | None:
    stop_id, stop_name, lat, lon = row
    lat_f, lon_f = _to_float(lat), _to_float(lon)
    if lat_f is None or lon_f is None:
        return None
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": _point(lon_f, lat_f)},
        # Only what the map reads: the popup shows these two and the layer
        # styles on neither. On a feed with half a million stops, a property
        # nobody looks at is tens of megabytes of browser memory.
        "properties": {"stop_id": stop_id, "stop_name": stop_name},
    }


# Everything but route_id is optional in GTFS, and naming a column a feed does
# not have is a binder error that would take the whole routes layer down with
# it - silently, since these builders fall back to an empty collection.
_OPTIONAL_ROUTE_COLUMNS = ("route_short_name", "route_long_name", "route_color", "route_type")


def _table_columns(con, table: str) -> set[str]:
    try:
        return {row[0] for row in con.execute(f'DESCRIBE "{table}"').fetchall()}
    except Exception:
        return set()


def _route_shapes_sql(con) -> str:
    """One representative shape per route: the first shape any of its trips uses.

    DISTINCT ON collapses the trips join before anything touches the geometry.
    """
    present = _table_columns(con, "routes")
    selected = ",\n           ".join(
        f"COALESCE(r.{column}, '') AS {column}" if column in present else f"'' AS {column}"
        for column in _OPTIONAL_ROUTE_COLUMNS
    )
    return f"""
    SELECT DISTINCT ON (r.route_id)
           t.shape_id AS shape_id,
           r.route_id,
           {selected}
    FROM routes r
    JOIN trips t ON t.route_id = r.route_id
    WHERE t.shape_id IS NOT NULL AND t.shape_id != ''
    """


_STOPS_COLUMNS = """
    SELECT stop_id, stop_name, stop_lat, stop_lon
    FROM stops
"""


def stops_geojson(con, stop_ids: list[str] | None = None) -> dict:
    try:
        where, params = "", []
        if stop_ids:
            placeholders = ", ".join(["?"] * len(stop_ids))
            where = f"WHERE stop_id IN ({placeholders})"
            params = stop_ids
        rows = con.execute(f"{_STOPS_COLUMNS} {where}", params).fetchall()
    except Exception:
        return {"type": "FeatureCollection", "features": []}

    features = [f for f in (_stop_feature(row) for row in rows) if f is not None]
    return {"type": "FeatureCollection", "features": features}


def shapes_geojson(con, shape_ids: list[str] | None = None) -> dict:
    features = []
    try:
        where, params = "", []
        if shape_ids:
            placeholders = ", ".join(["?"] * len(shape_ids))
            where = f"WHERE shape_id IN ({placeholders})"
            params = shape_ids
        for shape_id, coords in _walk_shapes(con, where, params):
            features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": coords},
                    "properties": {"shape_id": shape_id},
                }
            )
    except Exception:
        return {"type": "FeatureCollection", "features": []}
    return {"type": "FeatureCollection", "features": features}


def vertex_step(con) -> int:
    """How many points to advance between kept vertices, for the whole map.

    1 means every vertex, which is what all but the largest feeds get. Derived
    from the feed's own shapes.txt row count against `MAX_MAP_VERTICES`, so no
    feed is special-cased: one twice as large is simply reduced twice as hard,
    and there is no threshold to retune as feeds grow.
    """
    try:
        total = con.execute("SELECT COUNT(*) FROM shapes").fetchone()[0]
    except Exception:
        return 1
    return max(1, -(-total // MAX_MAP_VERTICES))


def _thin(coords: list[list[float]], step: int) -> list[list[float]]:
    """Every `step`-th point, plus the last so a line still ends where it ends."""
    if step <= 1 or len(coords) <= 2:
        return coords
    kept = coords[::step]
    if kept[-1] != coords[-1]:
        kept.append(coords[-1])
    return kept


def _walk_shapes(con, where: str, params: list, step: int = 1) -> Iterator[tuple[str, list[list[float]]]]:
    """Yield one (shape_id, coordinates) pair per shape, in a single pass.

    The rows arrive grouped by shape_id, so a shape is complete as soon as the
    id changes. That is what lets the whole table stream without ever holding
    more than one shape's points. Thinning happens per shape, here, so every
    shape survives at whatever resolution the step allows - no shape is dropped.
    """
    cursor = con.execute(
        f"""
        SELECT shape_id, shape_pt_lat, shape_pt_lon
        FROM shapes {where}
        ORDER BY shape_id, TRY_CAST(shape_pt_sequence AS INTEGER)
        """,
        params,
    )

    current_id, coords = None, []
    while True:
        rows = cursor.fetchmany(50_000)
        if not rows:
            break
        for shape_id, lat, lon in rows:
            if shape_id != current_id:
                if len(coords) >= 2:
                    yield current_id, _thin(coords, step)
                current_id, coords = shape_id, []
            lat_f, lon_f = _to_float(lat), _to_float(lon)
            if lat_f is not None and lon_f is not None:
                coords.append(_point(lon_f, lat_f))
    if len(coords) >= 2:
        yield current_id, _thin(coords, step)


def _batched(features: Iterator[dict]) -> Iterator[list[dict]]:
    batch: list[dict] = []
    for feature in features:
        batch.append(feature)
        if len(batch) >= BATCH_SIZE:
            yield batch
            batch = []
    if batch:
        yield batch


def _stage_route_shapes(con) -> None:
    """Materialise the route-representative shape ids once per request.

    Both the routes layer and the shapes layer need this set, and leaving it as
    an inline subquery had DuckDB re-deriving the routes/trips join for every
    shape it considered. As a temp table it is computed once and the anti-join
    against ten million shape rows becomes a hash probe.
    """
    con.execute("CREATE OR REPLACE TEMP TABLE _route_shapes AS " + _route_shapes_sql(con))


def _count_drawable(con, membership: str) -> int:
    """Shapes with at least two points, which is what actually gets drawn.

    Counting shape ids alone overstates it: a shape with a single point, or one
    named by a trip but absent from shapes.txt, never becomes a LineString, and
    a progress total that can never be reached is worse than none.
    """
    return con.execute(f"""
        SELECT COUNT(*) FROM (
            SELECT shape_id FROM shapes
            WHERE shape_id {membership} (SELECT shape_id FROM _route_shapes)
            GROUP BY shape_id HAVING COUNT(*) >= 2
        ) t
        """).fetchone()[0]


def shape_step(con) -> int:
    """The thinning step the shape layers will use, for the stream header."""
    return vertex_step(con)


def count_stops(con) -> int:
    try:
        return con.execute("SELECT COUNT(*) FROM stops WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL").fetchone()[
            0
        ]
    except Exception:
        return 0


def count_shapes(con) -> int:
    try:
        _stage_route_shapes(con)
        return _count_drawable(con, "NOT IN")
    except Exception:
        return 0


def count_routes(con) -> int:
    try:
        _stage_route_shapes(con)
        return _count_drawable(con, "IN")
    except Exception:
        return 0


def iter_stops(con) -> Iterator[list[dict]]:
    """Every stop, in batches."""
    try:
        cursor = con.execute(_STOPS_COLUMNS)
    except Exception:
        return

    def features() -> Iterator[dict]:
        while True:
            rows = cursor.fetchmany(BATCH_SIZE)
            if not rows:
                break
            for row in rows:
                feature = _stop_feature(row)
                if feature is not None:
                    yield feature

    yield from _batched(features())


def iter_routes(con) -> Iterator[list[dict]]:
    """Each route's representative shape, coloured by the feed's route_color.

    One query, one pass over `shapes`. The previous version resolved the route
    list first and then re-queried the shapes with an id per route, which meant
    scanning and sorting the whole shapes table a second time - on a national
    feed that is a few hundred MB read twice for no gain.
    """
    try:
        _stage_route_shapes(con)
        routes = {row[0]: row for row in con.execute("SELECT * FROM _route_shapes").fetchall()}
    except Exception:
        return
    if not routes:
        return

    def features() -> Iterator[dict]:
        where = "WHERE shape_id IN (SELECT shape_id FROM _route_shapes)"
        for shape_id, coords in _walk_shapes(con, where, [], vertex_step(con)):
            route = routes.get(shape_id)
            if route is None:
                continue
            _, route_id, short_name, long_name, color, route_type = route
            yield {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": coords},
                "properties": {
                    "shape_id": shape_id,
                    "route_id": route_id,
                    "route_short_name": short_name,
                    "route_long_name": long_name,
                    "route_color": color or "3388ff",
                    # The map styles line width and opacity on this; without it
                    # every route silently drew at the default width.
                    "route_type": route_type,
                },
            }

    yield from _batched(features())


def iter_shapes(con) -> Iterator[list[dict]]:
    """Shapes no route already draws, in batches.

    The exclusion is done here rather than in the browser: a route's shape used
    to be sent in both payloads and de-duplicated client-side, which meant
    downloading and parsing it twice before throwing one copy away.
    """
    try:
        _stage_route_shapes(con)
        where = "WHERE shape_id NOT IN (SELECT shape_id FROM _route_shapes)"
        walker = _walk_shapes(con, where, [], vertex_step(con))

        def features() -> Iterator[dict]:
            for shape_id, coords in walker:
                yield {
                    "type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": coords},
                    "properties": {"shape_id": shape_id},
                }

        yield from _batched(features())
    except Exception:
        return


def routes_geojson(con) -> dict:
    """The whole routes layer as one collection, for callers that want it."""
    features = [feature for batch in iter_routes(con) for feature in batch]
    return {"type": "FeatureCollection", "features": features}
