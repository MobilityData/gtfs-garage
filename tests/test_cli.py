from pathlib import Path

import pytest

from gtfs_garage import __version__
from gtfs_garage import cli as cli_module
from gtfs_garage.cli import DEFAULT_HOST, DEFAULT_PORT, DEFAULT_WORKDIR_KEEP, build_parser, main


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


class TestWorkdirOption:
    def test_defaults_to_the_run_choosing_its_own(self):
        args = build_parser().parse_args(["feed.zip"])
        assert args.workdir is None
        assert args.workdir_keep == DEFAULT_WORKDIR_KEEP

    def test_accepts_a_directory_and_a_limit(self):
        args = build_parser().parse_args(["feed.zip", "--workdir", "/tmp/gg", "--workdir-keep", "1"])
        assert (args.workdir, args.workdir_keep) == ("/tmp/gg", 1)

    def test_a_named_directory_is_kept_and_used(self, feed_dir: Path, tmp_path: Path, monkeypatch):
        built = {}
        monkeypatch.setattr("gtfs_garage.cli.uvicorn.run", lambda app, host, port: built.update(app=app))
        workdir = tmp_path / "gg-work"

        assert main([str(feed_dir), "--no-browser", "--workdir", str(workdir), "--workdir-keep", "2"]) == 0

        workspace = built["app"].state.workspace
        assert workspace.path == workdir.resolve()
        assert workspace.persistent is True
        assert workspace.keep == 2
        # The feed that was named on the command line is in it already.
        assert len(workspace.entries()) == 1

    def test_the_path_is_printed_on_every_run(self, feed_dir: Path, tmp_path: Path, monkeypatch, capsys):
        """Not knowing where a feed landed is the problem the flag solves, and a
        flag nobody is told about does not solve it."""
        monkeypatch.setattr("gtfs_garage.cli.uvicorn.run", lambda *a, **k: None)
        workdir = tmp_path / "gg-work"
        assert main([str(feed_dir), "--no-browser", "--workdir", str(workdir)]) == 0
        printed = capsys.readouterr().out
        assert str(workdir.resolve()) in printed
        assert "kept" in printed

    def test_an_unasked_for_workdir_says_it_will_go(self, feed_dir: Path, monkeypatch, capsys):
        monkeypatch.setattr("gtfs_garage.cli.uvicorn.run", lambda *a, **k: None)
        assert main([str(feed_dir), "--no-browser"]) == 0
        assert "removed on exit" in capsys.readouterr().out

    def test_an_export_unpacks_into_the_workdir_and_leaves_it(self, feed_zip: Path, tmp_path: Path):
        """A zip still has to be unpacked somewhere; --workdir says where."""
        workdir = tmp_path / "gg-work"
        assert main([str(feed_zip), "--export", str(tmp_path / "out"), "--workdir", str(workdir)]) == 0
        assert (tmp_path / "out" / "stops.parquet").exists()
        assert any(workdir.rglob("*"))

    def test_an_export_without_one_leaves_nothing_behind(self, feed_zip: Path, tmp_path: Path, monkeypatch):
        recorded = []
        real = cli_module.Workspace.resolve

        def remember(*args, **kwargs):
            made = real(*args, **kwargs)
            recorded.append(made)
            return made

        monkeypatch.setattr(cli_module.Workspace, "resolve", remember)
        assert main([str(feed_zip), "--export", str(tmp_path / "out")]) == 0
        assert recorded and not recorded[0].path.exists()
