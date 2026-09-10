from pathlib import Path

import pytest

from gtfs_garage import __version__
from gtfs_garage.cli import DEFAULT_HOST, DEFAULT_PORT, build_parser, main


class TestArgumentParsing:
    def test_feed_is_optional(self):
        args = build_parser().parse_args([])
        assert args.feed is None

    def test_defaults(self):
        args = build_parser().parse_args(["feed.zip"])
        assert (args.feed, args.host, args.port, args.no_browser) == (
            "feed.zip",
            DEFAULT_HOST,
            DEFAULT_PORT,
            False,
        )

    def test_overrides(self):
        args = build_parser().parse_args(["feed.zip", "--port", "9000", "--host", "0.0.0.0", "--no-browser"])
        assert (args.port, args.host, args.no_browser) == (9000, "0.0.0.0", True)

    def test_version_exits_zero(self, capsys):
        with pytest.raises(SystemExit) as exit_info:
            build_parser().parse_args(["--version"])
        assert exit_info.value.code == 0
        assert __version__ in capsys.readouterr().out


class TestMain:
    def test_reports_an_unreadable_feed_and_exits_nonzero(self, tmp_path: Path, capsys):
        # Fails before any server starts, so this does not bind a port.
        assert main([str(tmp_path / "missing.zip"), "--no-browser"]) == 1
        assert "error:" in capsys.readouterr().err

    def test_serves_once_the_feed_loads(self, feed_dir: Path, monkeypatch, capsys):
        served = {}

        def fake_run(app, host, port):
            served.update(host=host, port=port, app=app)

        monkeypatch.setattr("gtfs_garage.cli.uvicorn.run", fake_run)

        assert main([str(feed_dir), "--no-browser", "--port", "8999"]) == 0
        assert served["port"] == 8999
        assert served["host"] == DEFAULT_HOST
        assert "http://127.0.0.1:8999" in capsys.readouterr().out

    def test_opens_a_browser_unless_suppressed(self, feed_dir: Path, monkeypatch):
        opened = []
        monkeypatch.setattr("gtfs_garage.cli.uvicorn.run", lambda *a, **k: None)
        monkeypatch.setattr("gtfs_garage.cli.webbrowser.open", lambda url: opened.append(url))

        timers = []

        class ImmediateTimer:
            def __init__(self, _delay, function):
                self.function = function
                timers.append(self)

            def start(self):
                self.function()

        monkeypatch.setattr("gtfs_garage.cli.threading.Timer", ImmediateTimer)

        assert main([str(feed_dir), "--port", "8998"]) == 0
        assert opened == ["http://127.0.0.1:8998"]


class TestBasemapOption:
    def test_defaults_to_none_so_the_app_decides(self):
        assert build_parser().parse_args(["feed.zip"]).basemap is None

    def test_accepts_a_preset(self):
        assert build_parser().parse_args(["feed.zip", "--basemap", "esri"]).basemap == "esri"

    def test_accepts_a_url(self):
        url = "https://example.org/styles/mine.json"
        assert build_parser().parse_args(["feed.zip", "--basemap", url]).basemap == url

    def test_is_passed_to_the_app(self, feed_dir: Path, monkeypatch):
        built = {}
        monkeypatch.setattr("gtfs_garage.cli.uvicorn.run", lambda app, host, port: built.update(app=app))
        assert main([str(feed_dir), "--no-browser", "--basemap", "osm"]) == 0
        assert built["app"].state.basemap == "osm"
