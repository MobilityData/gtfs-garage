from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from gtfs_garage.server import app as app_module
from gtfs_garage.server.app import create_app


@pytest.fixture()
def client(feed_dir: Path):
    app = create_app(str(feed_dir))
    with TestClient(app) as running:
        yield running


@pytest.fixture()
def empty_client():
    app = create_app()
    with TestClient(app) as running:
        yield running


class TestWithoutAFeed:
    def test_tables_reports_conflict(self, empty_client: TestClient):
        assert empty_client.get("/api/tables").status_code == 409

    def test_table_reports_conflict(self, empty_client: TestClient):
        assert empty_client.get("/api/table/stops").status_code == 409

    def test_load_without_a_file_or_path_is_a_bad_request(self, empty_client: TestClient):
        assert empty_client.post("/api/load").status_code == 400

    def test_load_of_a_missing_path_is_a_bad_request(self, empty_client: TestClient):
        assert empty_client.post("/api/load", params={"path": "/nope/feed.zip"}).status_code == 400


class TestTables:
    def test_lists_the_feeds_tables(self, client: TestClient):
        body = client.get("/api/tables").json()
        assert {t["name"] for t in body["tables"]} >= {"routes", "stops", "trips"}

    def test_reports_the_loaded_source(self, client: TestClient):
        assert client.get("/api/tables").json()["source"].endswith("mini-gtfs")

    def test_does_not_offer_links_to_absent_files(self, client: TestClient):
        tables = {t["name"]: t for t in client.get("/api/tables").json()["tables"]}
        route_id = next(c for c in tables["routes"]["columns"] if c["name"] == "route_id")
        assert all(link["table"] != "fare_rules" for link in route_id["related"])


class TestTablePages:
    def test_returns_a_page(self, client: TestClient):
        body = client.get("/api/table/stops").json()
        assert body["total"] == 3
        assert body["page"] == 1

    def test_honours_paging_parameters(self, client: TestClient):
        body = client.get("/api/table/stop_times", params={"page": 2, "page_size": 2}).json()
        assert body["page"] == 2
        assert len(body["rows"]) == 2

    def test_unknown_table_is_not_found(self, client: TestClient):
        assert client.get("/api/table/nope").status_code == 404

    def test_malformed_filters_are_rejected(self, client: TestClient):
        response = client.get("/api/table/stops", params={"filters": "{not json"})
        assert response.status_code == 400

    def test_filters_must_be_a_list(self, client: TestClient):
        response = client.get("/api/table/stops", params={"filters": '{"column": "x"}'})
        assert response.status_code == 400

    def test_filters_are_applied(self, client: TestClient):
        response = client.get(
            "/api/table/trips",
            params={"filters": '[{"column": "route_id", "op": "eq", "value": "R1"}]'},
        )
        assert response.json()["total"] == 2


class TestDistinct:
    def test_returns_values_and_counts(self, client: TestClient):
        values = client.get("/api/table/routes/distinct/route_type").json()["values"]
        assert {v["value"] for v in values} == {"1", "3"}

    def test_unknown_column_is_not_found(self, client: TestClient):
        assert client.get("/api/table/stops/distinct/nope").status_code == 404


class TestGeoJson:
    def test_stops_are_points(self, client: TestClient):
        body = client.get("/api/geojson/stops").json()
        assert len(body["features"]) == 3
        assert body["features"][0]["geometry"]["type"] == "Point"

    def test_a_single_stop_can_be_requested(self, client: TestClient):
        body = client.get("/api/geojson/stops", params={"stop_ids": "ST1"}).json()
        assert len(body["features"]) == 1

    def test_shapes_are_line_strings(self, client: TestClient):
        body = client.get("/api/geojson/shapes").json()
        assert body["features"][0]["geometry"]["type"] == "LineString"

    def test_routes_carry_their_colour_from_the_feed(self, client: TestClient):
        features = client.get("/api/geojson/routes").json()["features"]
        assert features[0]["properties"]["route_color"] == "FF0000"


class TestServingTheUi:
    def test_index_is_served_when_the_frontend_has_been_built(self, feed_dir: Path, tmp_path: Path, monkeypatch):
        # A stand-in for the built frontend, so this does not depend on whether
        # the checkout running the tests happens to have one. The opposite case
        # lives in test_frontend_assets.py.
        built = tmp_path / "web"
        built.mkdir()
        (built / "index.html").write_text("<h1>GTFS Garage</h1>", encoding="utf-8")
        monkeypatch.setattr(app_module, "web_root", lambda: built)

        with TestClient(create_app(str(feed_dir))) as client:
            response = client.get("/")

        assert response.status_code == 200
        assert "GTFS Garage" in response.text


def test_loading_a_second_feed_replaces_the_first(client: TestClient, feed_zip: Path):
    body = client.post("/api/load", params={"path": str(feed_zip)}).json()
    assert body["source"] == str(feed_zip)
    assert client.get("/api/tables").json()["source"] == str(feed_zip)


def test_a_failed_load_leaves_the_working_feed_in_place(client: TestClient):
    assert client.post("/api/load", params={"path": "/nope/feed.zip"}).status_code == 400
    assert client.get("/api/table/stops").json()["total"] == 3
