"""locations.geojson: the one GTFS file that is not a CSV.

GTFS-Flex describes pickup and drop-off zones as GeoJSON polygons, and
`stop_times.location_id` references a Feature's id. The loader flattens the
FeatureCollection to one row per Feature so the rest of the application can
treat it like any other file.
"""

import json
import shutil
from pathlib import Path

import pytest

from gtfs_garage.core import geojson as geojson_builders
from gtfs_garage.core.feed import GtfsFeed
from gtfs_garage.core.queries import table_summaries

FLEX_DIR = Path(__file__).parent / "data" / "flex-gtfs"


@pytest.fixture()
def flex_feed():
    feed = GtfsFeed(str(FLEX_DIR))
    yield feed
    feed.close()


def _feed_with_locations(tmp_path: Path, content: str) -> GtfsFeed:
    """A copy of the fixture whose locations.geojson is whatever is given."""
    for txt in FLEX_DIR.glob("*.txt"):
        shutil.copy(txt, tmp_path)
    (tmp_path / "locations.geojson").write_text(content, encoding="utf-8")
    return GtfsFeed(str(tmp_path))


class TestLoading:
    def test_the_zones_become_a_table(self, flex_feed):
        assert flex_feed.tables["locations"] == [
            "id",
            "stop_name",
            "stop_desc",
            "geometry_type",
            "geometry",
        ]
        assert flex_feed.row_count("locations") == 3

    def test_a_feature_without_properties_still_becomes_a_row(self, flex_feed):
        rows = flex_feed.cursor().execute('SELECT id, stop_name FROM "locations" ORDER BY id').fetchall()
        assert ("zone-bare", None) in rows

    def test_both_polygon_and_multipolygon_are_read(self, flex_feed):
        kinds = flex_feed.cursor().execute('SELECT DISTINCT geometry_type FROM "locations"').fetchall()
        assert {k for (k,) in kinds} == {"Polygon", "MultiPolygon"}

    def test_it_appears_in_the_load_report(self, flex_feed):
        entry = next(f for f in flex_feed.stats.files if f.table == "locations")
        assert entry.name == "locations.geojson"
        assert entry.bytes > 0
        assert entry.columns == 5

    def test_it_converts_to_parquet_like_every_other_file(self, flex_feed):
        """Not a detail: `_drop_extracted_csvs` releases the extracted feed only
        when every file converted, so one that could not would keep the whole
        feed's CSVs on disk."""
        entry = next(f for f in flex_feed.stats.files if f.table == "locations")
        assert entry.parquet_bytes is not None
        assert flex_feed.row_count("locations") == 3

    def test_the_geometry_survives_the_parquet_round_trip(self, flex_feed):
        stored = flex_feed.cursor().execute("SELECT geometry FROM \"locations\" WHERE id = 'zone-north'").fetchone()[0]
        assert json.loads(stored)["type"] == "Polygon"


class TestABrokenFileNeverTakesTheFeedDown:
    """The project's rule applied to a new file type: a feed with something
    wrong in it still opens, because that is what an inspection tool is for.
    """

    @pytest.mark.parametrize(
        "label, content",
        [
            ("truncated", '{ "type": "FeatureCollection", "features": [ {"id": '),
            ("not json", "this is not json"),
            ("empty", ""),
            ("not a feature collection", '{"type":"Point","coordinates":[0,0]}'),
        ],
    )
    def test_the_rest_of_the_feed_still_loads(self, tmp_path, label, content):
        feed = _feed_with_locations(tmp_path, content)
        try:
            assert "stops" in feed.tables
            assert feed.row_count("stops") > 0
        finally:
            feed.close()

    def test_a_forbidden_geometry_is_shown_rather_than_hidden(self, tmp_path):
        """GTFS permits only Polygon and MultiPolygon. A Point is wrong, and
        the row is still listed with its type visible - hiding it would conceal
        exactly what someone opened the feed to find."""
        feed = _feed_with_locations(
            tmp_path,
            json.dumps(
                {
                    "type": "FeatureCollection",
                    "features": [
                        {
                            "type": "Feature",
                            "id": "wrong",
                            "properties": {},
                            "geometry": {"type": "Point", "coordinates": [0, 0]},
                        }
                    ],
                }
            ),
        )
        try:
            rows = feed.cursor().execute('SELECT id, geometry_type FROM "locations"').fetchall()
            assert rows == [("wrong", "Point")]
        finally:
            feed.close()

    def test_an_unreadable_file_leaves_no_half_built_table(self, tmp_path):
        feed = _feed_with_locations(tmp_path, '{"type": "FeatureCollection", "features": [{')
        try:
            assert "locations" not in feed.tables
        finally:
            feed.close()


class TestItLinksLikeAnyOtherFile:
    def test_stop_times_location_id_resolves_to_a_zone(self, flex_feed):
        summaries = table_summaries(flex_feed)
        columns = {c["name"]: c for c in next(t for t in summaries if t["name"] == "stop_times")["columns"]}
        assert columns["location_id"]["fk_table"] == "locations"
        assert columns["location_id"]["fk_column"] == "id"

    def test_a_zone_offers_the_reverse_link(self, flex_feed):
        summaries = table_summaries(flex_feed)
        columns = {c["name"]: c for c in next(t for t in summaries if t["name"] == "locations")["columns"]}
        assert {(r["table"], r["column"]) for r in columns["id"]["related"]} == {("stop_times", "location_id")}


class TestDrawing:
    def test_every_zone_is_offered_to_the_map(self, flex_feed):
        con = flex_feed.cursor()
        assert geojson_builders.count_locations(con) == 3
        features = [f for batch in geojson_builders.iter_locations(con) for f in batch]
        assert {f["geometry"]["type"] for f in features} == {"Polygon", "MultiPolygon"}

    def test_a_feature_carries_only_what_the_map_reads(self, flex_feed):
        """Properties are sent for every feature, so anything nothing reads is
        paid for twice - in the payload and in the browser's copy."""
        features = [f for batch in geojson_builders.iter_locations(flex_feed.cursor()) for f in batch]
        assert all(set(f["properties"]) == {"location_id", "stop_name"} for f in features)

    def test_a_single_zone_can_be_highlighted(self, flex_feed):
        collection = geojson_builders.locations_geojson(flex_feed.cursor(), ["zone-split"])
        assert len(collection["features"]) == 1
        assert collection["features"][0]["geometry"]["type"] == "MultiPolygon"

    def test_a_feed_without_zones_draws_nothing_rather_than_failing(self, feed):
        """`feed` is the ordinary fixture, which has no locations.geojson."""
        con = feed.cursor()
        assert geojson_builders.count_locations(con) == 0
        assert list(geojson_builders.iter_locations(con)) == []
        assert geojson_builders.locations_geojson(con)["features"] == []


class TestOverTheApi:
    """The zone layer reaches the browser the same way every other one does."""

    @pytest.fixture()
    def flex_client(self):
        from fastapi.testclient import TestClient

        from gtfs_garage.server.app import create_app

        with TestClient(create_app(str(FLEX_DIR))) as running:
            yield running

    def _stream(self, client, path):
        response = client.get(path)
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/x-ndjson")
        lines = [json.loads(line) for line in response.text.splitlines() if line]
        assert lines[0]["type"] == "header"
        return lines[0]["total"], [f for m in lines[1:] for f in m["features"]]

    def test_the_zones_stream_as_polygons(self, flex_client):
        total, features = self._stream(flex_client, "/api/geojson/locations")
        assert total == 3
        assert {f["geometry"]["type"] for f in features} == {"Polygon", "MultiPolygon"}

    def test_zones_are_never_thinned(self, flex_client):
        """The vertex budget exists for the millions of points in shapes.txt. A
        feed's zones are a few hundred vertices, so the header always says 1."""
        response = flex_client.get("/api/geojson/locations")
        assert json.loads(response.text.splitlines()[0])["step"] == 1

    def test_a_single_zone_is_answered_whole(self, flex_client):
        response = flex_client.get("/api/geojson/locations", params={"location_ids": "zone-north"})
        features = response.json()["features"]
        assert len(features) == 1
        assert features[0]["properties"]["location_id"] == "zone-north"

    def test_the_zones_are_listed_as_a_table(self, flex_client):
        tables = {t["name"]: t for t in flex_client.get("/api/tables").json()["tables"]}
        assert tables["locations"]["row_count"] == 3

    def test_a_zone_can_be_filtered_like_any_other_row(self, flex_client):
        page = flex_client.get(
            "/api/table/locations",
            params={"filters": json.dumps([{"column": "geometry_type", "op": "eq", "value": "Polygon"}])},
        ).json()
        assert page["total"] == 2
