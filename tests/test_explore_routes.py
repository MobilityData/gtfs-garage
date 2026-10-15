"""The HTTP layer over the derived views.

The core modules are tested directly; what is checked here is the part only the
server owns - the status codes, the shape the contract promises, and that a
route id containing a slash survives being put in a path.
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from gtfs_garage.server.app import create_app


@pytest.fixture()
def client(explore_feed_dir: Path):
    app = create_app(str(explore_feed_dir), optimise=False)
    with TestClient(app) as running:
        yield running


@pytest.fixture()
def empty_client():
    app = create_app()
    with TestClient(app) as running:
        yield running


class TestWithoutAFeed:
    @pytest.mark.parametrize("path", ["/api/overview", "/api/calendar", "/api/routes", "/api/routes/R1"])
    def test_every_view_reports_conflict(self, empty_client: TestClient, path: str):
        assert empty_client.get(path).status_code == 409


class TestOverview:
    def test_answers_with_the_shape_the_contract_promises(self, client: TestClient):
        body = client.get("/api/overview").json()
        assert set(body) >= {"published", "agencies", "modes", "counts", "service", "features"}
        assert body["counts"]["routes"] == 4

    def test_names_the_tables_behind_each_feature(self, client: TestClient):
        features = {f["name"]: f for f in client.get("/api/overview").json()["features"]}
        assert features["Route shapes"]["tables"] == ["shapes"]


class TestCalendar:
    def test_returns_a_day_per_date_and_the_patterns_over_them(self, client: TestClient):
        body = client.get("/api/calendar").json()
        assert body["first_date"] == "2026-01-01"
        assert len(body["days"]) == 181
        assert body["days"][0]["service_date"] == "2026-01-01"
        assert {pattern["name"] for pattern in body["patterns"]} >= {"Saturdays", "Sundays"}
        assert [day["name"] for day in body["weekdays"]][0] == "Monday"

    def test_a_feed_with_no_calendar_is_a_not_found(self, tmp_path: Path):
        directory = tmp_path / "nocal"
        directory.mkdir()
        (directory / "stops.txt").write_text("stop_id,stop_name,stop_lat,stop_lon\nS1,One,45.0,-73.0\n")
        with TestClient(create_app(str(directory), optimise=False)) as running:
            response = running.get("/api/calendar")
            assert response.status_code == 404
            assert "calendar" in response.json()["detail"]


class TestRoutes:
    def test_lists_every_route(self, client: TestClient):
        routes = client.get("/api/routes").json()["routes"]
        assert [route["route_id"] for route in routes] == ["2", "10", "101", "RL"]

    def test_one_route_carries_its_patterns_and_timetable(self, client: TestClient):
        body = client.get("/api/routes/2").json()
        assert body["route"]["route_long_name"] == "Hilltop"
        assert body["mode"] == "Bus"
        assert len(body["patterns"]) == 2
        assert body["timetable"]["first_departure"] == "07:15:00"

    def test_an_unknown_route_is_a_not_found(self, client: TestClient):
        assert client.get("/api/routes/nope").status_code == 404

    def test_a_route_id_containing_a_slash_is_reachable(self, tmp_path: Path):
        """Real feeds contain them, and a path parameter that splits on one
        turns an ordinary route into a 404 that looks like a missing feature."""
        directory = tmp_path / "slash"
        directory.mkdir()
        (directory / "stops.txt").write_text("stop_id,stop_name,stop_lat,stop_lon\nS1,One,45.0,-73.0\n")
        (directory / "routes.txt").write_text("route_id,route_type\nA/B,3\n")

        with TestClient(create_app(str(directory), optimise=False)) as running:
            assert running.get("/api/routes/A%2FB").json()["route"]["route_id"] == "A/B"
