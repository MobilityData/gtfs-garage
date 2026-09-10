"""Builds GeoJSON FeatureCollections for the map view directly from the
DuckDB views - no separate export step, so it stays correct for whatever feed
is currently loaded.
"""

from __future__ import annotations


def _to_float(value) -> float | None:
    try:
        if value in (None, ""):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def stops_geojson(con, stop_ids: list[str] | None = None) -> dict:
    try:
        where, params = "", []
        if stop_ids:
            placeholders = ", ".join(["?"] * len(stop_ids))
            where = f"WHERE stop_id IN ({placeholders})"
            params = stop_ids
        rows = con.execute(
            f"""
            SELECT stop_id, stop_name, stop_lat, stop_lon,
                   COALESCE(location_type, ''), COALESCE(parent_station, '')
            FROM stops {where}
            """,
            params,
        ).fetchall()
    except Exception:
        return {"type": "FeatureCollection", "features": []}

    features = []
    for stop_id, stop_name, lat, lon, location_type, parent_station in rows:
        lat_f, lon_f = _to_float(lat), _to_float(lon)
        if lat_f is None or lon_f is None:
            continue
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon_f, lat_f]},
                "properties": {
                    "stop_id": stop_id,
                    "stop_name": stop_name,
                    "location_type": location_type,
                    "parent_station": parent_station,
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


def shapes_geojson(con, shape_ids: list[str] | None = None) -> dict:
    try:
        where, params = "", []
        if shape_ids:
            placeholders = ", ".join(["?"] * len(shape_ids))
            where = f"WHERE shape_id IN ({placeholders})"
            params = shape_ids
        rows = con.execute(
            f"""
            SELECT shape_id, shape_pt_lat, shape_pt_lon, TRY_CAST(shape_pt_sequence AS INTEGER)
            FROM shapes {where}
            ORDER BY shape_id, TRY_CAST(shape_pt_sequence AS INTEGER)
            """,
            params,
        ).fetchall()
    except Exception:
        return {"type": "FeatureCollection", "features": []}

    by_shape: dict[str, list[list[float]]] = {}
    for shape_id, lat, lon, _seq in rows:
        lat_f, lon_f = _to_float(lat), _to_float(lon)
        if lat_f is None or lon_f is None:
            continue
        by_shape.setdefault(shape_id, []).append([lon_f, lat_f])

    features = [
        {
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {"shape_id": shape_id},
        }
        for shape_id, coords in by_shape.items()
        if len(coords) >= 2
    ]
    return {"type": "FeatureCollection", "features": features}


def routes_geojson(con) -> dict:
    """One representative shape per route (the first shape used by any of its
    trips), colored with the feed's own route_color when present.
    """
    try:
        rows = con.execute(
            """
            SELECT DISTINCT ON (r.route_id)
                   r.route_id, r.route_short_name, r.route_long_name,
                   COALESCE(r.route_color, ''), t.shape_id
            FROM routes r
            JOIN trips t ON t.route_id = r.route_id
            WHERE t.shape_id IS NOT NULL AND t.shape_id != ''
            """
        ).fetchall()
    except Exception:
        return {"type": "FeatureCollection", "features": []}

    shape_ids = [row[4] for row in rows]
    route_by_shape = {row[4]: row for row in rows}
    shapes = shapes_geojson(con, shape_ids)

    for feature in shapes["features"]:
        shape_id = feature["properties"]["shape_id"]
        route_id, short_name, long_name, color, _ = route_by_shape[shape_id]
        feature["properties"].update(
            {
                "route_id": route_id,
                "route_short_name": short_name,
                "route_long_name": long_name,
                "route_color": color or "3388ff",
            }
        )
    return shapes
