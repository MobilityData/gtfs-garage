"""Demo feeds over HTTP: listing them, reading their reports, opening them, adding your own.

What matters most is what opening a demo must not do: push a feed of the user's
own out of a workdir that keeps only a few.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from gtfs_garage.core import demos
from gtfs_garage.server.app import create_app

REPORT = json.dumps(
    {"summary": {}, "notices": [{"code": "unused_shape", "totalNotices": 2, "sampleNotices": [{}, {}]}]}
)


@pytest.fixture()
def workdir(tmp_path: Path) -> Path:
    return tmp_path / "work"


@pytest.fixture()
def client(workdir: Path):
    with TestClient(create_app(workdir=str(workdir))) as running:
        yield running


def _feeds(client: TestClient) -> list[dict]:
    return client.get("/api/workspace").json()["feeds"]


def _current(client: TestClient) -> str:
    return next(feed["id"] for feed in _feeds(client) if feed["current"])


def _own_feed(client: TestClient, feed_dir: Path, tmp_path: Path, name: str) -> str:
    copied = tmp_path / name
    shutil.copytree(feed_dir, copied)
    assert client.post("/api/load", params={"path": str(copied)}).status_code == 200
    return _current(client)


def test_every_built_in_demo_is_listed_with_its_notices(client: TestClient):
    listed = {demo["id"]: demo for demo in client.get("/api/quality/demos").json()["demos"]}
    assert list(listed) == ["main", "future", "no-calendar", "parse-errors", "crash", "subfolder"]
    assert all(demo["builtin"] and demo["available"] for demo in listed.values())
    assert listed["main"]["notices"]["stop_too_far_from_shape"] == 5
    covered = set().union(*(demo["notices"] for demo in listed.values()))
    assert len(covered) >= 171


def test_a_demo_report_is_served_as_the_validator_wrote_it(client: TestClient):
    report = client.get("/api/quality/demos/main/report").json()
    on_disk = json.loads((demos.BUILTIN_DIR / "main.report.json").read_text(encoding="utf-8"))
    assert report == on_disk


def test_a_demo_tables_are_read_without_opening_it(client: TestClient):
    tables = {
        table["name"]: table["columns"] for table in client.get("/api/quality/demos/main/tables").json()["tables"]
    }
    assert "stop_id" in tables["stops"]
    assert tables["locations"] == ["id"]
    assert client.get("/api/tables").status_code != 200 or client.get("/api/tables").json().get("source") is None


def test_a_demo_whose_files_sit_in_a_folder_is_served(client: TestClient):
    response = client.get("/demos/subfolder/api/tables")
    assert response.status_code == 200
    assert {table["name"] for table in response.json()["tables"]} >= {"stops", "trips"}


def test_an_unknown_demo_is_a_404(client: TestClient):
    assert client.get("/api/quality/demos/nowhere/report").status_code == 404
    assert client.get("/demos/nowhere/api/tables").status_code == 404


def test_a_demo_is_served_beside_your_feed_not_in_its_place(client: TestClient, feed_dir: Path, tmp_path: Path):
    mine = _own_feed(client, feed_dir, tmp_path, "mine")
    before = client.get("/api/tables").json()["source"]
    stops = client.get(
        "/demos/main/api/table/stops",
        params={"filters": json.dumps([{"column": "stop_id", "op": "eq", "value": "S702"}])},
    )
    assert stops.status_code == 200 and stops.json()["rows"]
    assert client.get("/demos/main/api/geojson/stops", params={"stop_ids": ["S702"]}).json()["features"]
    # The server's own feed is the one it was.
    assert client.get("/api/tables").json()["source"] == before
    assert _current(client) == mine


def test_a_demo_cannot_load_feeds_or_touch_the_workdir(client: TestClient):
    assert client.post("/demos/main/api/load", params={"path": "/"}).status_code in (404, 405)
    assert client.delete("/demos/main/api/workspace").status_code in (404, 405)


def test_opening_demos_never_evicts_your_own_feed(client: TestClient, feed_dir: Path, tmp_path: Path):
    mine = _own_feed(client, feed_dir, tmp_path, "mine")
    # More demos than the workdir keeps feeds.
    for demo_id in ("main", "future", "no-calendar", "parse-errors", "crash"):
        assert client.get(f"/demos/{demo_id}/api/tables").status_code == 200
    _own_feed(client, feed_dir, tmp_path, "later")
    feeds = {feed["id"]: feed for feed in _feeds(client)}
    assert mine in feeds
    assert sum(feed["kind"] == "demo" for feed in feeds.values()) == 5


def test_a_demo_open_beside_your_feed_cannot_be_deleted(client: TestClient):
    assert client.get("/demos/main/api/tables").status_code == 200
    slot = next(feed["id"] for feed in _feeds(client) if feed["kind"] == "demo")
    assert client.delete(f"/api/workspace/feeds/{slot}").status_code == 409


def test_your_own_demo_keeps_its_feed_and_can_be_removed(client: TestClient, feed_dir: Path, tmp_path: Path):
    mine = _own_feed(client, feed_dir, tmp_path, "mine")
    added = client.post(
        "/api/quality/demos",
        data={"feed_id": mine, "title": "My feed"},
        files={"report": ("report.json", REPORT, "application/json")},
    )
    assert added.status_code == 200, added.text
    demo = added.json()
    assert demo["builtin"] is False and demo["feed_id"] == mine and demo["notices"] == {"unused_shape": 2}

    # Three newer feeds would push it out of a workdir that keeps three; a demo's feed stays.
    for name in ("b", "c", "d"):
        _own_feed(client, feed_dir, tmp_path, name)
    assert mine in {feed["id"] for feed in _feeds(client)}

    assert client.get(f"/demos/{demo['id']}/api/tables").status_code == 200
    tables = client.get(f"/api/quality/demos/{demo['id']}/tables").json()["tables"]
    assert any(table["name"] == "stops" and "stop_id" in table["columns"] for table in tables)

    remaining = client.delete(f"/api/quality/demos/{demo['id']}").json()["demos"]
    assert demo["id"] not in {entry["id"] for entry in remaining}
    assert mine in {feed["id"] for feed in _feeds(client)}


def test_a_built_in_demo_cannot_be_removed(client: TestClient):
    assert client.delete("/api/quality/demos/main").status_code == 404


def test_your_own_demo_needs_a_feed_and_a_report(client: TestClient, feed_dir: Path, tmp_path: Path):
    no_feed = client.post("/api/quality/demos", data={"feed_id": "nowhere"}, files={"report": ("r.json", REPORT)})
    assert no_feed.status_code == 400
    mine = _own_feed(client, feed_dir, tmp_path, "mine")
    not_a_report = client.post("/api/quality/demos", data={"feed_id": mine}, files={"report": ("r.json", '{"a": 1}')})
    assert not_a_report.status_code == 400
    assert "notices" in not_a_report.json()["detail"]


GUIDE = """code: unused_shape

# Written by an analyst.
steps:
  - text: Shape {{shapeId}} is not used by any trip.
"""


def test_a_tour_is_saved_in_the_workdir_as_written(client: TestClient, workdir: Path):
    saved = client.put("/api/quality/guides/unused_shape", json={"yaml": GUIDE})
    assert saved.status_code == 200, saved.text
    assert saved.json()["guide"]["steps"][0]["text"].startswith("Shape {{shapeId}}")
    assert (workdir / "guides" / "unused_shape.yaml").read_text(encoding="utf-8") == GUIDE
    listed = client.get("/api/quality/guides").json()["guides"]
    assert [entry["code"] for entry in listed] == ["unused_shape"]
    assert "# Written by an analyst." in listed[0]["yaml"]


def test_a_tour_that_fails_the_check_is_not_saved(client: TestClient, workdir: Path):
    bad = client.put("/api/quality/guides/unused_shape", json={"yaml": GUIDE.replace("shapeId", "routeId")})
    assert bad.status_code == 422
    assert "routeId" in bad.json()["detail"]
    assert not (workdir / "guides" / "unused_shape.yaml").exists()
    assert (
        client.put(
            "/api/quality/guides/not_a_notice", json={"yaml": "code: not_a_notice\nsteps: [{text: t}]"}
        ).status_code
        == 422
    )
    assert client.put("/api/quality/guides/unused_shape", json={"yaml": "steps: [unclosed"}).status_code == 422


def test_a_saved_tour_can_be_removed(client: TestClient):
    client.put("/api/quality/guides/unused_shape", json={"yaml": GUIDE})
    assert client.delete("/api/quality/guides/unused_shape").json()["guides"] == []
    assert client.get("/api/quality/guides/unused_shape").status_code == 404
    assert client.delete("/api/quality/guides/unused_shape").status_code == 404
    assert client.get("/api/quality/guides/..%2F..%2Fetc").status_code == 404


def test_the_studio_is_the_same_page(client: TestClient):
    root, studio = client.get("/"), client.get("/studio")
    assert studio.status_code == root.status_code
    assert studio.text == root.text
