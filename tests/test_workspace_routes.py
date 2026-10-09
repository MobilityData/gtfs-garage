"""The workdir over HTTP: listing it, reopening a feed from it, emptying it."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from gtfs_garage.server.app import create_app


@pytest.fixture()
def workdir(tmp_path: Path) -> Path:
    return tmp_path / "work"


@pytest.fixture()
def client(workdir: Path):
    with TestClient(create_app(workdir=str(workdir))) as running:
        yield running


@pytest.fixture()
def two_feeds(client: TestClient, feed_dir: Path, tmp_path: Path) -> list[str]:
    """Two feeds loaded in turn, so the workdir holds one that is not open."""
    ids = []
    for name in ("alpha", "beta"):
        copied = tmp_path / name
        shutil.copytree(feed_dir, copied)
        client.post("/api/load", params={"path": str(copied)})
        ids.append(_current(client))
    return ids


def _feeds(client: TestClient) -> list[dict]:
    return client.get("/api/workspace").json()["feeds"]


def _current(client: TestClient) -> str:
    return next(feed["id"] for feed in _feeds(client) if feed["current"])


class TestListing:
    def test_reports_the_directory_it_was_given(self, client: TestClient, workdir: Path):
        body = client.get("/api/workspace").json()
        assert body["path"] == str(workdir.resolve())
        assert body["persistent"] is True
        assert body["keep"] == 3

    def test_an_empty_workdir_is_a_listing_rather_than_an_error(self, client: TestClient):
        """The viewer asks before any feed is loaded, and must get an answer."""
        body = client.get("/api/workspace").json()
        assert body["feeds"] == []
        assert body["total_bytes"] >= 0

    def test_a_loaded_feed_appears_with_its_size(self, client: TestClient, feed_dir: Path):
        client.post("/api/load", params={"path": str(feed_dir)})
        (feed,) = _feeds(client)
        assert feed["current"] is True
        assert feed["reloadable"] is True
        assert feed["label"] == str(feed_dir)
        assert feed["kind"] == "path"
        assert feed["bytes"] > 0
        assert feed["tables"] > 0

    def test_an_uploaded_feed_is_named_for_the_upload(self, client: TestClient, feed_zip: Path):
        """Not for the directory it landed in, which is the old complaint."""
        with feed_zip.open("rb") as handle:
            client.post("/api/load", files={"file": ("montreal.zip", handle, "application/zip")})
        assert _feeds(client)[0]["label"] == "montreal.zip"

    def test_the_server_says_it_has_a_workdir(self, client: TestClient):
        assert client.get("/api/config").json()["workspace"] is True


class TestReload:
    def test_reopens_a_feed_already_on_disk(self, client: TestClient, two_feeds: list[str]):
        first, second = two_feeds
        assert _current(client) == second

        body = client.post(f"/api/workspace/feeds/{first}/reload")
        assert body.status_code == 200
        assert _current(client) == first
        assert [table["name"] for table in body.json()["tables"]]

    def test_reopening_costs_no_conversion(self, client: TestClient, two_feeds: list[str]):
        """The point of storing the Parquet: there is nothing left to convert."""
        body = client.post(f"/api/workspace/feeds/{two_feeds[0]}/reload").json()
        assert body["metrics"]["convert_ms"] is None
        assert body["metrics"]["extract_ms"] is None

    def test_a_reopened_feed_is_still_the_download_it_was(self, client: TestClient, feed_zip: Path, feed_dir: Path):
        """Reopening reads a local directory, but that is not where it came from.

        Rewriting `kind` on reload would turn every feed in the workdir into a
        "path" after one round trip, and the column would stop meaning anything.
        """
        with feed_zip.open("rb") as handle:
            client.post("/api/load", files={"file": ("montreal.zip", handle, "application/zip")})
        uploaded = _current(client)
        client.post("/api/load", params={"path": str(feed_dir)})

        client.post(f"/api/workspace/feeds/{uploaded}/reload")
        assert next(feed for feed in _feeds(client) if feed["id"] == uploaded)["kind"] == "upload"

    def test_a_reopened_feed_still_answers_queries(self, client: TestClient, two_feeds: list[str]):
        client.post(f"/api/workspace/feeds/{two_feeds[0]}/reload")
        assert client.get("/api/table/stops").json()["total"] == 3

    def test_a_feed_that_is_not_there_is_a_404(self, client: TestClient):
        assert client.post("/api/workspace/feeds/nope-00000000/reload").status_code == 404

    def test_a_traversing_id_is_a_404_rather_than_a_path(self, client: TestClient):
        assert client.post("/api/workspace/feeds/..%2F..%2Fetc/reload").status_code == 404

    def test_a_feed_with_no_parquet_cannot_be_reopened(self, workdir: Path, feed_dir: Path):
        """--no-parquet leaves the slot with nothing to reopen from."""
        with TestClient(create_app(workdir=str(workdir), optimise=False)) as client:
            client.post("/api/load", params={"path": str(feed_dir)})
            feed_id = _feeds(client)[0]["id"]
            assert _feeds(client)[0]["reloadable"] is False
            assert client.post(f"/api/workspace/feeds/{feed_id}/reload").status_code == 404


class TestRemoval:
    def test_removes_a_feed_that_is_not_open(self, client: TestClient, two_feeds: list[str]):
        first, second = two_feeds
        body = client.request("DELETE", f"/api/workspace/feeds/{first}")
        assert body.status_code == 200
        assert [feed["id"] for feed in body.json()["feeds"]] == [second]

    def test_refuses_the_feed_being_served(self, client: TestClient, two_feeds: list[str]):
        response = client.request("DELETE", f"/api/workspace/feeds/{two_feeds[1]}")
        assert response.status_code == 409
        assert "open" in response.json()["detail"]
        assert len(_feeds(client)) == 2

    def test_a_feed_that_is_not_there_is_a_404(self, client: TestClient):
        assert client.request("DELETE", "/api/workspace/feeds/nope-00000000").status_code == 404

    def test_emptying_keeps_only_what_is_open(self, client: TestClient, two_feeds: list[str]):
        body = client.request("DELETE", "/api/workspace").json()
        assert [feed["id"] for feed in body["feeds"]] == [two_feeds[1]]
        assert body["feeds"][0]["current"] is True

    def test_the_served_feed_still_works_after_emptying(self, client: TestClient, two_feeds: list[str]):
        client.request("DELETE", "/api/workspace")
        assert client.get("/api/table/stops").json()["total"] == 3

    def test_emptying_an_empty_workdir_is_not_an_error(self, client: TestClient):
        assert client.request("DELETE", "/api/workspace").status_code == 200


class TestRetention:
    def test_the_oldest_feed_is_dropped_past_the_limit(self, workdir: Path, feed_dir: Path, tmp_path: Path):
        with TestClient(create_app(workdir=str(workdir), workdir_keep=2)) as client:
            for name in ("one", "two", "three"):
                copied = tmp_path / name
                shutil.copytree(feed_dir, copied)
                client.post("/api/load", params={"path": str(copied)})
            labels = {Path(feed["label"]).name for feed in _feeds(client)}
            assert len(labels) == 2
            assert "one" not in labels

    def test_keeping_one_drops_the_previous_feed_at_once(self, workdir: Path, feed_dir: Path, tmp_path: Path):
        """What someone wanting the workdir cleaned on every load asks for."""
        with TestClient(create_app(workdir=str(workdir), workdir_keep=1)) as client:
            for name in ("one", "two"):
                copied = tmp_path / name
                shutil.copytree(feed_dir, copied)
                client.post("/api/load", params={"path": str(copied)})
            assert [Path(feed["label"]).name for feed in _feeds(client)] == ["two"]


class TestModes:
    def test_a_workdir_survives_the_server_that_made_it(self, workdir: Path, feed_dir: Path):
        with TestClient(create_app(workdir=str(workdir))) as client:
            client.post("/api/load", params={"path": str(feed_dir)})
            feed_id = _feeds(client)[0]["id"]

        # A second run, over the same directory: the feed is still there, and
        # opens without being read from its source again.
        with TestClient(create_app(workdir=str(workdir))) as client:
            assert [feed["id"] for feed in _feeds(client)] == [feed_id]
            assert client.post(f"/api/workspace/feeds/{feed_id}/reload").status_code == 200

    def test_without_a_workdir_nothing_is_left_behind(self, feed_dir: Path):
        with TestClient(create_app()) as client:
            client.post("/api/load", params={"path": str(feed_dir)})
            body = client.get("/api/workspace").json()
            assert body["persistent"] is False
            path = Path(body["path"])
            assert path.exists()
        assert not path.exists()

    def test_the_environment_can_name_the_workdir(self, tmp_path: Path, monkeypatch):
        """Required: the dev loop starts uvicorn with a factory and no arguments."""
        monkeypatch.setenv("GTFS_GARAGE_WORKDIR", str(tmp_path / "env-work"))
        monkeypatch.setenv("GTFS_GARAGE_WORKDIR_KEEP", "7")
        with TestClient(create_app()) as client:
            body = client.get("/api/workspace").json()
        assert body["path"] == str((tmp_path / "env-work").resolve())
        assert body["keep"] == 7

    def test_an_unreadable_keep_setting_falls_back_rather_than_failing(self, tmp_path: Path, monkeypatch):
        monkeypatch.setenv("GTFS_GARAGE_WORKDIR", str(tmp_path / "env-work"))
        monkeypatch.setenv("GTFS_GARAGE_WORKDIR_KEEP", "not a number")
        with TestClient(create_app()) as client:
            assert client.get("/api/workspace").json()["keep"] == 3


def test_a_reopened_feed_reports_the_sizes_of_the_feed_it_came_from(client: TestClient, feed_zip: Path, workdir: Path):
    """The manifest beside the Parquet is the only place these survive.

    Conversion deletes the CSVs and a zip member's compressed size lives only in
    the archive's directory, so without it a reopened feed could only report the
    Parquet it became.
    """
    with feed_zip.open("rb") as handle:
        first = client.post("/api/load", files={"file": ("montreal.zip", handle, "application/zip")}).json()
    feed_id = _current(client)

    again = client.post(f"/api/workspace/feeds/{feed_id}/reload").json()
    before = {f["table"]: f for f in first["metrics"]["files"]}
    after = {f["table"]: f for f in again["metrics"]["files"]}
    assert before.keys() == after.keys()
    for table, metrics in after.items():
        assert metrics["bytes"] == before[table]["bytes"]
        assert metrics["compressed_bytes"] == before[table]["compressed_bytes"]
