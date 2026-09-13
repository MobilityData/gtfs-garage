import json
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


def read_stream(client: TestClient, path: str) -> tuple[int, list[dict]]:
    """Consume an NDJSON layer into its declared total and its features."""
    response = client.get(path)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-ndjson")

    lines = [json.loads(line) for line in response.text.splitlines() if line]
    assert lines[0]["type"] == "header"
    features = [f for message in lines[1:] for f in message["features"]]
    return lines[0]["total"], features


class TestGeoJson:
    """The whole-feed layers stream; an id-filtered highlight does not."""

    def test_stops_are_points(self, client: TestClient):
        total, features = read_stream(client, "/api/geojson/stops")
        assert len(features) == 3
        assert features[0]["geometry"]["type"] == "Point"
        # The total drives the on-map progress, so it has to be reachable.
        assert total == len(features)

    def test_a_single_stop_is_answered_whole(self, client: TestClient):
        # Small enough not to be worth streaming, and the map highlight wants
        # it in one piece.
        response = client.get("/api/geojson/stops", params={"stop_ids": "ST1"})
        assert len(response.json()["features"]) == 1

    def test_shapes_are_line_strings(self, client: TestClient):
        _, features = read_stream(client, "/api/geojson/shapes")
        assert all(f["geometry"]["type"] == "LineString" for f in features)

    def test_routes_carry_their_colour_from_the_feed(self, client: TestClient):
        _, features = read_stream(client, "/api/geojson/routes")
        assert features[0]["properties"]["route_color"] == "FF0000"

    def test_routes_carry_the_type_the_map_styles_on(self, client: TestClient):
        _, features = read_stream(client, "/api/geojson/routes")
        assert features[0]["properties"]["route_type"] == "1"

    def test_a_shape_a_route_draws_is_not_sent_twice(self, client: TestClient):
        _, routes = read_stream(client, "/api/geojson/routes")
        _, shapes = read_stream(client, "/api/geojson/shapes")
        drawn = {f["properties"]["shape_id"] for f in routes}
        assert drawn and not drawn & {f["properties"]["shape_id"] for f in shapes}

    def test_a_layer_needs_a_feed(self, empty_client: TestClient):
        # Refused up front rather than as a truncated body the client cannot
        # tell apart from a network failure.
        assert empty_client.get("/api/geojson/stops").status_code == 409

    def test_layers_are_compressed(self, client: TestClient):
        response = client.get("/api/geojson/stops", headers={"Accept-Encoding": "gzip"})
        assert response.headers.get("content-encoding") == "gzip"


class TestLoadProgress:
    def test_reports_idle_when_nothing_is_loading(self, client: TestClient):
        body = client.get("/api/load/progress").json()
        assert body["running"] is False
        assert body["phase"] == "done"

    def test_is_answerable_without_a_feed(self, empty_client: TestClient):
        assert empty_client.get("/api/load/progress").status_code == 200


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
