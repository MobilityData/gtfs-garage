import pytest
from fastapi.testclient import TestClient

from gtfs_garage import __version__
from gtfs_garage.server.app import BASEMAP_ENV_VAR, DEFAULT_BASEMAP, create_app


def config_of(app) -> dict:
    with TestClient(app) as client:
        return client.get("/api/config").json()


def test_defaults_to_a_keyless_basemap():
    assert config_of(create_app())["basemap"] == DEFAULT_BASEMAP


def test_reports_the_package_version():
    assert config_of(create_app())["version"] == __version__


def test_an_explicit_basemap_wins():
    assert config_of(create_app(basemap="esri"))["basemap"] == "esri"


def test_a_custom_url_is_passed_through_untouched():
    style = "https://example.org/styles/mine.json"
    assert config_of(create_app(basemap=style))["basemap"] == style


def test_the_environment_variable_is_used_when_no_argument_is_given(monkeypatch):
    monkeypatch.setenv(BASEMAP_ENV_VAR, "osm")
    assert config_of(create_app())["basemap"] == "osm"


def test_an_argument_overrides_the_environment(monkeypatch):
    monkeypatch.setenv(BASEMAP_ENV_VAR, "osm")
    assert config_of(create_app(basemap="none"))["basemap"] == "none"


def test_config_is_available_before_a_feed_is_loaded():
    # The interface reads it at startup, which may be before any feed exists.
    with TestClient(create_app()) as client:
        assert client.get("/api/config").status_code == 200
        assert client.get("/api/tables").status_code == 409


@pytest.mark.parametrize("preset", ["openfreemap", "esri", "osm", "carto", "none"])
def test_documented_presets_are_accepted(preset: str):
    assert config_of(create_app(basemap=preset))["basemap"] == preset
