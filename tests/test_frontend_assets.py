"""The built frontend is not in version control, so a source checkout may not
have one. The server must say so clearly rather than fail obscurely.
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from gtfs_garage.server import app as app_module
from gtfs_garage.server.app import BUILD_COMMAND, create_app, frontend_is_built, web_root


def test_web_root_is_inside_the_package():
    assert web_root().name == "web"
    assert web_root().parent.name == "gtfs_garage"


def test_frontend_is_built_reports_the_current_checkout():
    assert frontend_is_built() == (web_root() / "index.html").is_file()


@pytest.fixture()
def app_without_a_frontend(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(app_module, "web_root", lambda: tmp_path / "not-built")
    with TestClient(create_app()) as client:
        yield client


def test_index_explains_how_to_build_when_the_frontend_is_missing(app_without_a_frontend: TestClient):
    response = app_without_a_frontend.get("/")
    assert response.status_code == 503
    assert BUILD_COMMAND in response.text


def test_the_api_still_works_without_a_frontend(app_without_a_frontend: TestClient):
    # 409 (no feed loaded) rather than a crash: the API is unaffected.
    assert app_without_a_frontend.get("/api/tables").status_code == 409
