from pathlib import Path

import pytest

from gtfs_garage import __version__
from gtfs_garage import cli as cli_module
from gtfs_garage.cli import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_WORKDIR_KEEP,
    REOPEN_LATEST,
    build_parser,
    main,
)


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
        """A flag nobody is told about does not solve the problem it exists for."""
        monkeypatch.setattr("gtfs_garage.cli.uvicorn.run", lambda *a, **k: None)
        workdir = tmp_path / "gg-work"
        assert main([str(feed_dir), "--no-browser", "--workdir", str(workdir)]) == 0
        printed = capsys.readouterr().out
        assert str(workdir.resolve()) in printed
        assert "kept" in printed

    def test_an_unasked_for_workdir_is_kept_and_says_what_bounds_it(self, feed_dir: Path, monkeypatch, capsys):
        """It outlives the run now, so the line says what stops it growing."""
        monkeypatch.setattr("gtfs_garage.cli.uvicorn.run", lambda *a, **k: None)
        assert main([str(feed_dir), "--no-browser"]) == 0
        assert f"newest {DEFAULT_WORKDIR_KEEP} kept" in capsys.readouterr().out

    def test_every_feed_kept_is_said_rather_than_a_number(self, feed_dir: Path, monkeypatch, capsys):
        monkeypatch.setattr("gtfs_garage.cli.uvicorn.run", lambda *a, **k: None)
        assert main([str(feed_dir), "--no-browser", "--workdir-keep", "0"]) == 0
        assert "every feed kept" in capsys.readouterr().out

    def test_a_feed_loaded_without_a_workdir_is_there_for_the_next_run(self, feed_dir: Path, monkeypatch):
        """The reason the default is kept: the load dialog has something to
        offer on the next start instead of an empty workdir every time."""
        built = {}
        monkeypatch.setattr("gtfs_garage.cli.uvicorn.run", lambda app, host, port: built.update(app=app))
        assert main([str(feed_dir), "--no-browser"]) == 0

        assert main(["--no-browser", "--no-reopen"]) == 0
        stored = built["app"].state.workspace.entries()
        assert [entry.label for entry in stored] == [str(feed_dir)]
        assert stored[0].reloadable

    def test_an_export_unpacks_into_the_workdir_and_leaves_it(self, feed_zip: Path, tmp_path: Path):
        workdir = tmp_path / "gg-work"
        assert main([str(feed_zip), "--export", str(tmp_path / "out"), "--workdir", str(workdir)]) == 0
        assert (tmp_path / "out" / "stops.parquet").exists()
        assert any(workdir.rglob("*"))

    def test_an_export_without_one_leaves_nothing_behind(self, feed_zip: Path, tmp_path: Path, monkeypatch):
        """Not even in the kept default: the answer is the Parquet it wrote, and
        an export should neither leave a copy nor evict a server's feed."""
        recorded = []
        real = cli_module.Workspace.ephemeral

        def remember(*args, **kwargs):
            made = real(*args, **kwargs)
            recorded.append(made)
            return made

        monkeypatch.setattr(cli_module.Workspace, "ephemeral", remember)
        assert main([str(feed_zip), "--export", str(tmp_path / "out")]) == 0
        assert recorded and not recorded[0].path.exists()
        assert not cli_module.Workspace.resolve().entries()


class TestReopenOption:
    def test_is_absent_unless_asked_for(self):
        assert build_parser().parse_args(["--workdir", "/tmp/gg"]).reopen is None

    def test_bare_means_the_most_recent(self):
        assert build_parser().parse_args(["--reopen"]).reopen == REOPEN_LATEST

    def test_an_id_picks_one(self):
        assert build_parser().parse_args(["--reopen", "montreal-zip-7f3a91c0"]).reopen == "montreal-zip-7f3a91c0"

    def test_a_feed_and_the_flag_together_are_refused(self, capsys):
        """Two answers to the same question; preferring one silently would leave
        the user browsing something they did not ask for."""
        assert main(["feed.zip", "--reopen", "--no-browser"]) == 1
        assert "not both" in capsys.readouterr().err

    def test_an_empty_workdir_exits_nonzero_rather_than_serving_nothing(self, tmp_path: Path, capsys):
        assert main(["--reopen", "--workdir", str(tmp_path / "empty"), "--no-browser"]) == 1
        assert "to reopen" in capsys.readouterr().err

    def test_serves_a_stored_feed_with_no_feed_named(self, feed_dir: Path, tmp_path: Path, monkeypatch):
        workdir = tmp_path / "gg-work"
        monkeypatch.setattr("gtfs_garage.cli.uvicorn.run", lambda *a, **k: None)
        assert main([str(feed_dir), "--no-browser", "--workdir", str(workdir)]) == 0

        built = {}
        monkeypatch.setattr("gtfs_garage.cli.uvicorn.run", lambda app, host, port: built.update(app=app))
        assert main(["--no-browser", "--workdir", str(workdir), "--reopen"]) == 0
        assert built["app"].state.feeds.current().tables


class TestNoReopenOption:
    """Ignoring the feed the workdir itself names as the one to open."""

    def test_is_off_unless_asked_for(self):
        assert build_parser().parse_args(["--workdir", "/tmp/gg"]).no_reopen is False

    def test_the_two_reopen_flags_together_are_refused(self, capsys):
        """One names a feed to open and the other opens none. Picking either
        silently would be guessing at which the user meant."""
        assert main(["--reopen", "--no-reopen", "--no-browser"]) == 1
        assert "opens none" in capsys.readouterr().err

    def test_leaves_the_server_empty_where_the_workdir_names_a_feed(self, feed_dir: Path, tmp_path: Path, monkeypatch):
        workdir = tmp_path / "gg-work"
        monkeypatch.setattr("gtfs_garage.cli.uvicorn.run", lambda *a, **k: None)
        assert main([str(feed_dir), "--no-browser", "--workdir", str(workdir)]) == 0

        marked = cli_module.Workspace(workdir, persistent=True)
        marked.set_startup_feed(marked.latest().id)

        built = {}
        monkeypatch.setattr("gtfs_garage.cli.uvicorn.run", lambda app, host, port: built.update(app=app))
        assert main(["--no-browser", "--workdir", str(workdir)]) == 0
        assert built["app"].state.feeds.is_loaded

        assert main(["--no-browser", "--workdir", str(workdir), "--no-reopen"]) == 0
        assert not built["app"].state.feeds.is_loaded
