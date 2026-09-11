"""Opening a feed from an upload, a local path, or a URL."""

import io
import shutil
import urllib.error
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from gtfs_garage.core.feed import GtfsLoadError
from gtfs_garage.server import state as state_module
from gtfs_garage.server.app import create_app
from gtfs_garage.server.state import FeedRegistry


@pytest.fixture()
def client():
    with TestClient(create_app()) as running:
        yield running


class FakeResponse(io.BytesIO):
    """Stands in for the object urlopen returns.

    Carries `headers` because the download reads Content-Length from it to
    report progress; a real urlopen response always has them.
    """

    def __init__(self, payload: bytes, headers: dict | None = None):
        super().__init__(payload)
        self.headers = {"Content-Length": str(len(payload))} if headers is None else headers

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


@pytest.fixture()
def served_feed(feed_zip: Path, monkeypatch):
    """Serve the fixture zip to any URL the code opens."""
    payload = feed_zip.read_bytes()
    requested: list[str] = []

    def fake_urlopen(request, timeout=None):
        requested.append(request.full_url)
        return FakeResponse(payload)

    monkeypatch.setattr(state_module.urllib.request, "urlopen", fake_urlopen)
    return requested


class TestLoadFromUrl:
    def test_downloads_and_opens_the_feed(self, client: TestClient, served_feed: list[str]):
        response = client.post("/api/load", params={"url": "https://example.org/gtfs.zip"})
        assert response.status_code == 200
        assert served_feed == ["https://example.org/gtfs.zip"]
        assert client.get("/api/table/stops").json()["total"] == 3

    def test_reports_the_url_rather_than_the_temporary_file(self, client: TestClient, served_feed: list[str]):
        url = "https://example.org/gtfs.zip"
        assert client.post("/api/load", params={"url": url}).json()["source"] == url

    def test_a_url_wins_over_a_path(self, client: TestClient, served_feed: list[str], feed_dir: Path):
        body = client.post("/api/load", params={"url": "https://example.org/gtfs.zip", "path": str(feed_dir)}).json()
        assert body["source"] == "https://example.org/gtfs.zip"

    @pytest.mark.parametrize("url", ["file:///etc/passwd", "ftp://example.org/gtfs.zip", "not-a-url"])
    def test_only_http_urls_are_accepted(self, client: TestClient, url: str):
        response = client.post("/api/load", params={"url": url})
        assert response.status_code == 400
        assert "http" in response.json()["detail"]

    def test_a_server_error_is_reported(self, client: TestClient, monkeypatch):
        def fail(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, None)

        monkeypatch.setattr(state_module.urllib.request, "urlopen", fail)
        response = client.post("/api/load", params={"url": "https://example.org/missing.zip"})
        assert response.status_code == 400
        assert "404" in response.json()["detail"]

    def test_an_unreachable_host_is_reported(self, client: TestClient, monkeypatch):
        def fail(request, timeout=None):
            raise urllib.error.URLError("name resolution failed")

        monkeypatch.setattr(state_module.urllib.request, "urlopen", fail)
        response = client.post("/api/load", params={"url": "https://nope.invalid/gtfs.zip"})
        assert response.status_code == 400
        assert "Could not download" in response.json()["detail"]

    def test_something_that_is_not_a_feed_is_reported(self, client: TestClient, monkeypatch):
        monkeypatch.setattr(
            state_module.urllib.request,
            "urlopen",
            lambda request, timeout=None: FakeResponse(b"<html>not a feed</html>"),
        )
        response = client.post("/api/load", params={"url": "https://example.org/index.html"})
        assert response.status_code == 400

    def test_an_oversized_download_is_refused(self, client: TestClient, monkeypatch):
        monkeypatch.setattr(state_module, "MAX_DOWNLOAD_BYTES", 128)
        monkeypatch.setattr(
            state_module.urllib.request,
            "urlopen",
            lambda request, timeout=None: FakeResponse(b"x" * 5000),
        )
        response = client.post("/api/load", params={"url": "https://example.org/huge.zip"})
        assert response.status_code == 400
        assert "larger than" in response.json()["detail"]


class TestLoadFromUpload:
    def test_reports_the_filename_rather_than_the_temporary_path(self, client: TestClient, feed_zip: Path):
        with feed_zip.open("rb") as handle:
            body = client.post("/api/load", files={"file": ("montreal.zip", handle, "application/zip")})
        assert body.json()["source"] == "montreal.zip"


class TestRegistryScratchFiles:
    def test_a_download_filename_cannot_escape_its_directory(self, monkeypatch, tmp_path: Path):
        registry = FeedRegistry()
        monkeypatch.setattr(
            state_module.urllib.request,
            "urlopen",
            lambda request, timeout=None: FakeResponse(b"data"),
        )
        stored = registry.store_download("https://example.org/a/../../../etc/passwd")
        assert stored.name == "passwd"
        assert stored.parent.name.startswith("gtfs-garage-download-")
        registry.close()

    def test_scratch_directories_are_removed_on_close(self, feed_zip: Path):
        registry = FeedRegistry()
        with feed_zip.open("rb") as handle:
            stored = registry.store_upload("feed.zip", handle)
        assert stored.exists()
        registry.close()
        assert not stored.parent.exists()

    def test_a_non_http_scheme_is_rejected_before_any_request(self):
        registry = FeedRegistry()
        with pytest.raises(GtfsLoadError, match="http"):
            registry.store_download("file:///etc/passwd")
        registry.close()


def test_loading_nothing_at_all_is_a_bad_request(client: TestClient):
    assert client.post("/api/load").status_code == 400


def test_a_folder_path_still_works(client: TestClient, feed_dir: Path, tmp_path: Path):
    copied = tmp_path / "feed-copy"
    shutil.copytree(feed_dir, copied)
    assert client.post("/api/load", params={"path": str(copied)}).json()["source"] == str(copied)


class TestLoadFromChosenFolder:
    """A browser sends a chosen folder as its individual files."""

    def _folder_files(self, feed_dir: Path, prefix: str = "mini-gtfs"):
        return [
            ("files", (f"{prefix}/{path.name}", path.read_bytes(), "text/plain"))
            for path in sorted(feed_dir.glob("*.txt"))
        ]

    def test_reassembles_the_folder_and_opens_it(self, client: TestClient, feed_dir: Path):
        response = client.post("/api/load", files=self._folder_files(feed_dir))
        assert response.status_code == 200
        assert {t["name"] for t in response.json()["tables"]} >= {"routes", "stops", "trips"}
        assert client.get("/api/table/stops").json()["total"] == 3

    def test_reports_the_folder_name(self, client: TestClient, feed_dir: Path):
        response = client.post("/api/load", params={"name": "montreal-gtfs"}, files=self._folder_files(feed_dir))
        assert response.json()["source"] == "montreal-gtfs"

    def test_falls_back_to_a_generic_label(self, client: TestClient, feed_dir: Path):
        assert client.post("/api/load", files=self._folder_files(feed_dir)).json()["source"]

    def test_nested_names_are_flattened_so_the_feed_is_found(self, client: TestClient, feed_dir: Path):
        # The browser sends a relative path; the loader looks for files at one level.
        files = [
            ("files", (f"deep/nested/{path.name}", path.read_bytes(), "text/plain"))
            for path in sorted(feed_dir.glob("*.txt"))
        ]
        assert client.post("/api/load", files=files).status_code == 200

    def test_a_folder_with_nothing_usable_is_reported(self, client: TestClient):
        files = [("files", (".DS_Store", b"junk", "application/octet-stream"))]
        response = client.post("/api/load", files=files)
        assert response.status_code == 400

    def test_a_folder_without_gtfs_files_is_reported(self, client: TestClient):
        files = [("files", ("notes/readme.md", b"# hello", "text/markdown"))]
        response = client.post("/api/load", files=files)
        assert response.status_code == 400
        assert "GTFS" in response.json()["detail"] or "No GTFS" in response.json()["detail"]

    def test_a_filename_cannot_escape_the_scratch_directory(self, feed_dir: Path):
        registry = FeedRegistry()
        payloads = [(f"../../../{p.name}", io.BytesIO(p.read_bytes())) for p in feed_dir.glob("*.txt")]
        directory = registry.store_upload_folder(payloads)
        assert all(child.parent == directory for child in directory.iterdir())
        registry.close()


class TestLoadMetrics:
    """Every load reports what it cost, and which phases it actually had."""

    def test_a_local_path_has_no_acquire_phase(self, client: TestClient, feed_dir: Path):
        metrics = client.post("/api/load", params={"path": str(feed_dir)}).json()["metrics"]
        assert metrics["kind"] == "path"
        assert metrics["acquire_ms"] is None
        assert metrics["acquire_bytes"] is None

    def test_an_extracted_folder_has_no_unzip_phase(self, client: TestClient, feed_dir: Path):
        metrics = client.post("/api/load", params={"path": str(feed_dir)}).json()["metrics"]
        assert metrics["extract_ms"] is None

    def test_a_zip_path_reports_its_unzip(self, client: TestClient, feed_zip: Path):
        metrics = client.post("/api/load", params={"path": str(feed_zip)}).json()["metrics"]
        assert metrics["extract_ms"] is not None
        assert metrics["total_bytes"] == feed_zip.stat().st_size

    def test_a_download_reports_the_bytes_it_fetched(self, client: TestClient, served_feed: list[str], feed_zip: Path):
        metrics = client.post("/api/load", params={"url": "https://example.org/gtfs.zip"}).json()["metrics"]
        assert metrics["kind"] == "download"
        assert metrics["acquire_bytes"] == len(feed_zip.read_bytes())
        assert metrics["acquire_ms"] >= 0

    def test_an_upload_reports_the_bytes_it_received(self, client: TestClient, feed_zip: Path):
        payload = feed_zip.read_bytes()
        files = {"file": ("feed.zip", payload, "application/zip")}
        metrics = client.post("/api/load", files=files).json()["metrics"]
        assert metrics["kind"] == "upload"
        assert metrics["acquire_bytes"] == len(payload)

    def test_a_chosen_folder_reports_the_bytes_it_reassembled(self, client: TestClient, feed_dir: Path):
        sources = sorted(feed_dir.glob("*.txt"))
        files = [("files", (f"my-feed/{path.name}", path.read_bytes(), "text/plain")) for path in sources]
        metrics = client.post("/api/load", files=files, params={"name": "my-feed"}).json()["metrics"]
        assert metrics["kind"] == "folder"
        assert metrics["acquire_bytes"] == sum(path.stat().st_size for path in sources)

    def test_total_ms_is_the_phases_added_up(self, client: TestClient, feed_zip: Path):
        metrics = client.post("/api/load", params={"path": str(feed_zip)}).json()["metrics"]
        phases = metrics["extract_ms"] + metrics["register_ms"] + metrics["convert_ms"] + metrics["count_ms"]
        assert metrics["total_ms"] == pytest.approx(phases)

    def test_reports_what_the_conversion_cost_and_saved(self, client: TestClient, feed_zip: Path):
        metrics = client.post("/api/load", params={"path": str(feed_zip)}).json()["metrics"]
        assert metrics["convert_ms"] >= 0
        assert metrics["stored_bytes"] > 0
        assert all(f["parquet_bytes"] > 0 for f in metrics["files"])

    def test_lists_every_file_with_its_size_and_shape(self, client: TestClient, feed_dir: Path):
        metrics = client.post("/api/load", params={"path": str(feed_dir)}).json()["metrics"]
        files = {f["name"]: f for f in metrics["files"]}
        expected = ("agency", "calendar", "routes", "shapes", "stop_times", "stops", "trips")
        assert set(files) == {f"{table}.txt" for table in expected}
        assert files["stops.txt"]["bytes"] > 0
        assert files["stops.txt"]["row_count"] == 3
        assert files["stops.txt"]["columns"] > 0
        assert files["stops.txt"]["count_ms"] >= 0

    def test_only_a_zip_carries_compressed_sizes(self, client: TestClient, feed_dir: Path, feed_zip: Path):
        from_folder = client.post("/api/load", params={"path": str(feed_dir)}).json()["metrics"]
        assert all(f["compressed_bytes"] is None for f in from_folder["files"])

        from_zip = client.post("/api/load", params={"path": str(feed_zip)}).json()["metrics"]
        assert all(f["compressed_bytes"] > 0 for f in from_zip["files"])

    def test_tables_reports_the_same_load_it_is_serving(self, client: TestClient, feed_zip: Path):
        loaded = client.post("/api/load", params={"path": str(feed_zip)}).json()["metrics"]
        refreshed = client.get("/api/tables").json()["metrics"]
        # The counting pass runs again, so its timings are fresh, but what the
        # feed is and what it cost to open are the same load.
        assert refreshed["kind"] == loaded["kind"]
        assert refreshed["total_bytes"] == loaded["total_bytes"]
        assert refreshed["extract_ms"] == loaded["extract_ms"]
        assert all(f["row_count"] is not None for f in refreshed["files"])

    def test_a_failed_load_leaves_the_previous_feed_s_metrics_in_place(self, client: TestClient, feed_dir: Path):
        client.post("/api/load", params={"path": str(feed_dir)})
        assert client.post("/api/load", params={"path": "/nope/feed.zip"}).status_code == 400
        assert client.get("/api/tables").json()["metrics"]["kind"] == "path"
