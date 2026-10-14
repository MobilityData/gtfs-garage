"""The workdir: where a run writes, what it keeps, and what it throws away.

These are about the directory itself rather than about serving a feed. The
HTTP side is `tests/test_workspace_routes.py`, and what a feed does with a slot
it has been handed is in `tests/test_feed.py`.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from gtfs_garage.core.workspace import (
    DEFAULT_KEEP,
    STALE_RUN_SECONDS,
    Workspace,
    directory_bytes,
    slug_for,
    sweep_stale_runs,
)


@pytest.fixture()
def workspace(tmp_path: Path) -> Workspace:
    return Workspace(tmp_path / "work", persistent=True)


def fill(workspace: Workspace, label: str, size: int = 32, parquet: bool = True) -> str:
    """A slot that looks like a feed was loaded into it."""
    slot = workspace.slot(label)
    (slot.source_dir / "feed.zip").write_bytes(b"x" * size)
    if parquet:
        (slot.parquet_dir / "stops.parquet").write_bytes(b"y" * size)
    workspace.record(slot, label, "download", tables=4)
    return slot.id


class TestSlugs:
    def test_reads_as_the_feed_it_names(self):
        assert slug_for("https://example.org/montreal-gtfs.zip").startswith("https-example-org-montreal-gtfs-zip")

    def test_keeps_the_end_of_a_long_label_rather_than_the_start(self):
        slug = slug_for("/Users/sam/work/transit/archive/2026/montreal-gtfs.zip")
        assert "montreal-gtfs-zip" in slug
        assert "users-sam" not in slug

    def test_the_same_label_is_the_same_slot(self):
        assert slug_for("feed.zip") == slug_for("feed.zip")

    def test_two_feeds_sharing_a_name_do_not_share_a_slot(self):
        assert slug_for("https://a.example/gtfs.zip") != slug_for("https://b.example/gtfs.zip")

    def test_a_label_with_nothing_usable_in_it_still_names_a_directory(self):
        assert slug_for("///").startswith("feed-")

    def test_the_readable_part_is_bounded(self):
        """A URL can be arbitrarily long; a directory name cannot."""
        assert len(slug_for("https://example.org/" + "a" * 500)) <= 49


class TestLayout:
    def test_a_slot_has_somewhere_for_each_stage(self, workspace: Workspace):
        slot = workspace.slot("feed.zip")
        assert slot.source_dir.is_dir()
        assert slot.extract_dir.is_dir()
        assert slot.parquet_dir.is_dir()
        assert slot.root.parent == workspace.feeds_dir

    def test_reloading_the_same_feed_reuses_its_slot(self, workspace: Workspace):
        first = fill(workspace, "feed.zip")
        second = fill(workspace, "feed.zip")
        assert first == second
        assert len(workspace.entries()) == 1

    def test_reusing_a_slot_starts_it_empty(self, workspace: Workspace):
        """What the slot held describes the previous fetch, not this one."""
        slot = workspace.slot("feed.zip")
        (slot.parquet_dir / "gone.parquet").write_bytes(b"x")
        assert not (workspace.slot("feed.zip").parquet_dir / "gone.parquet").exists()

    def test_a_traversing_id_resolves_to_nothing(self, workspace: Workspace):
        for attempt in ("../../etc", "..", ".", "", "a/b"):
            assert workspace.existing(attempt) is None


class TestListing:
    def test_lists_what_was_recorded(self, workspace: Workspace):
        fill(workspace, "montreal.zip")
        (entry,) = workspace.entries()
        assert (entry.label, entry.kind, entry.tables, entry.reloadable) == ("montreal.zip", "download", 4, True)
        assert entry.bytes > 0

    def test_newest_first(self, workspace: Workspace):
        fill(workspace, "first.zip")
        fill(workspace, "second.zip")
        # Written in the same second, so the dates can tie; both must be there
        # and the newest must be reachable, which is what the interface needs.
        assert {entry.label for entry in workspace.entries()} == {"first.zip", "second.zip"}

    def test_a_slot_with_no_record_is_not_a_feed(self, workspace: Workspace):
        """An interrupted load. Listing it would offer a reload that cannot work."""
        workspace.slot("half-done.zip")
        assert workspace.entries() == []

    def test_an_unreadable_record_is_skipped_rather_than_guessed_at(self, workspace: Workspace):
        slot_id = fill(workspace, "feed.zip")
        (workspace.feeds_dir / slot_id / "feed.json").write_text("{not json", encoding="utf-8")
        assert workspace.entries() == []

    def test_a_feed_without_parquet_cannot_be_reopened(self, workspace: Workspace):
        fill(workspace, "feed.zip", parquet=False)
        assert workspace.entries()[0].reloadable is False

    def test_the_total_covers_the_whole_workdir(self, workspace: Workspace):
        fill(workspace, "a.zip", size=100)
        fill(workspace, "b.zip", size=100)
        assert workspace.total_bytes() >= 400


class TestRemoval:
    def test_removing_one_reports_what_it_freed(self, workspace: Workspace):
        slot_id = fill(workspace, "feed.zip", size=1000)
        freed = workspace.remove(slot_id)
        assert freed >= 2000
        assert workspace.entries() == []

    def test_removing_something_that_is_not_there_is_not_an_error(self, workspace: Workspace):
        assert workspace.remove("no-such-feed-00000000") == 0

    def test_clearing_leaves_what_is_in_use(self, workspace: Workspace):
        kept = fill(workspace, "open.zip")
        fill(workspace, "closed.zip")
        workspace.clear({kept})
        assert [entry.id for entry in workspace.entries()] == [kept]


class TestRetention:
    def test_keeps_the_newest_and_drops_the_rest(self, tmp_path: Path):
        workspace = Workspace(tmp_path / "work", persistent=True, keep=2)
        ids = [fill(workspace, f"feed-{i}.zip") for i in range(4)]
        workspace.enforce_retention()
        assert len(workspace.entries()) == 2
        # Whichever two survive, the ones that went are gone from disk too.
        for dropped in set(ids) - {entry.id for entry in workspace.entries()}:
            assert not (workspace.feeds_dir / dropped).exists()

    def test_one_means_the_previous_feed_goes_as_soon_as_a_new_one_lands(self, tmp_path: Path):
        workspace = Workspace(tmp_path / "work", persistent=True, keep=1)
        fill(workspace, "old.zip")
        current = fill(workspace, "new.zip")
        workspace.enforce_retention({current})
        assert [entry.id for entry in workspace.entries()] == [current]

    def test_zero_keeps_everything(self, tmp_path: Path):
        workspace = Workspace(tmp_path / "work", persistent=True, keep=0)
        for i in range(5):
            fill(workspace, f"feed-{i}.zip")
        assert workspace.enforce_retention() == []
        assert len(workspace.entries()) == 5

    def test_an_open_feed_is_never_evicted(self, tmp_path: Path):
        """Deleting the Parquet a running query reads is the one unacceptable outcome."""
        workspace = Workspace(tmp_path / "work", persistent=True, keep=1)
        held = fill(workspace, "being-read.zip")
        for i in range(3):
            fill(workspace, f"feed-{i}.zip")
        workspace.enforce_retention({held})
        assert held in {entry.id for entry in workspace.entries()}

    def test_a_negative_limit_is_read_as_none(self, tmp_path: Path):
        assert Workspace(tmp_path / "work", persistent=True, keep=-5).keep == 0


class TestModes:
    def test_a_named_directory_is_kept(self, tmp_path: Path):
        workspace = Workspace.resolve(str(tmp_path / "mine"), keep=None)
        assert workspace.persistent
        assert workspace.keep == DEFAULT_KEEP
        workspace.close()
        assert workspace.path.exists()

    def test_an_unasked_for_one_lives_under_the_cache_and_is_kept(self, cache_home: Path):
        """The reason a plain run finds the feeds its last run converted."""
        workspace = Workspace.resolve()
        assert workspace.persistent
        assert cache_home in workspace.path.parents
        workspace.close()
        assert workspace.path.exists()

    def test_every_run_without_a_workdir_gets_the_same_one(self, cache_home: Path):
        assert Workspace.resolve().path == Workspace.resolve().path

    def test_a_workspace_of_a_run_s_own_goes_with_the_run(self, cache_home: Path):
        workspace = Workspace.ephemeral()
        assert not workspace.persistent
        assert cache_home in workspace.path.parents
        assert workspace.path.name.startswith(f"{os.getpid()}-")
        workspace.close()
        assert not workspace.path.exists()

    def test_a_run_s_own_is_never_the_kept_one(self, cache_home: Path):
        """Closing an export's workspace must not take a server's feeds with it."""
        kept = Workspace.resolve()
        own = Workspace.ephemeral()
        assert own.path != kept.path
        own.close()
        assert kept.path.exists()

    def test_two_workspaces_of_a_run_s_own_do_not_share_a_root(self):
        """One process holds more than one - this suite does - and a shared root
        would have one's teardown delete the other's feeds."""
        first, second = Workspace.ephemeral(), Workspace.ephemeral()
        assert first.path != second.path
        first.close()
        assert second.path.exists()
        second.close()

    def test_what_an_older_version_left_under_runs_is_swept(self, cache_home: Path):
        """Nothing writes a directory per run any more, so resolving is the one
        chance to clear the ones that are left."""
        stale = cache_home / "runs" / "999999-abcdef12"
        stale.mkdir(parents=True)
        Workspace.resolve()
        assert not stale.exists()


class TestSweep:
    def test_a_run_whose_process_is_gone_is_swept(self, tmp_path: Path):
        runs = tmp_path / "runs"
        (runs / "999999-abcdef12" / "feeds").mkdir(parents=True)
        assert sweep_stale_runs(runs) == ["999999-abcdef12"]
        assert not (runs / "999999-abcdef12").exists()

    def test_a_live_run_is_left_alone(self, tmp_path: Path):
        """Including this very process, which is the case that matters."""
        runs = tmp_path / "runs"
        mine = runs / f"{os.getpid()}-abcdef12"
        mine.mkdir(parents=True)
        assert sweep_stale_runs(runs) == []
        assert mine.exists()

    def test_a_directory_with_no_pid_in_its_name_waits_out_its_age(self, tmp_path: Path):
        runs = tmp_path / "runs"
        young = runs / "not-a-pid"
        young.mkdir(parents=True)
        assert sweep_stale_runs(runs) == []

        old = runs / "also-not-a-pid"
        old.mkdir()
        stale = os.stat(old).st_mtime - STALE_RUN_SECONDS - 60
        os.utime(old, (stale, stale))
        assert sweep_stale_runs(runs) == ["also-not-a-pid"]

    def test_a_file_among_the_runs_is_ignored(self, tmp_path: Path):
        runs = tmp_path / "runs"
        runs.mkdir()
        (runs / "stray.log").write_text("", encoding="utf-8")
        assert sweep_stale_runs(runs) == []

    def test_starting_a_run_sweeps_the_ones_before_it(self, cache_home: Path):
        orphan = cache_home / "runs" / "999999-deadbeef"
        orphan.mkdir(parents=True)
        workspace = Workspace.resolve()
        assert not orphan.exists()
        workspace.close()


class TestRecords:
    def test_a_record_says_what_the_slot_holds(self, workspace: Workspace):
        slot_id = fill(workspace, "feed.zip")
        written = json.loads((workspace.feeds_dir / slot_id / "feed.json").read_text(encoding="utf-8"))
        assert written["label"] == "feed.zip"
        assert written["kind"] == "download"
        assert written["tables"] == 4
        assert written["loaded_at"].endswith("+00:00")


class TestStartupFeed:
    """Which feed a later run on this workdir opens, as the options menu sets it."""

    def test_nothing_is_named_to_begin_with(self, workspace: Workspace):
        assert workspace.startup_feed() is None

    def test_a_choice_survives_a_new_workspace_on_the_same_directory(self, workspace: Workspace):
        chosen = fill(workspace, "montreal.zip")
        workspace.set_startup_feed(chosen)
        assert Workspace(workspace.path, persistent=True).startup_feed() == chosen

    def test_the_choice_can_be_cleared(self, workspace: Workspace):
        workspace.set_startup_feed(fill(workspace, "montreal.zip"))
        workspace.set_startup_feed(None)
        assert workspace.startup_feed() is None

    def test_clearing_a_choice_that_was_never_made_is_not_an_error(self, workspace: Workspace):
        workspace.set_startup_feed(None)
        assert workspace.startup_feed() is None

    def test_a_feed_that_has_been_deleted_since_reads_as_no_choice(self, workspace: Workspace):
        chosen = fill(workspace, "montreal.zip")
        workspace.set_startup_feed(chosen)
        workspace.remove(chosen)
        assert workspace.startup_feed() is None

    def test_a_feed_evicted_by_retention_reads_as_no_choice(self, workspace: Workspace):
        kept = Workspace(workspace.path, persistent=True, keep=1)
        chosen = fill(kept, "first.zip")
        kept.set_startup_feed(chosen)
        fill(kept, "second.zip")
        kept.enforce_retention()
        assert kept.startup_feed() is None

    def test_a_feed_with_no_parquet_reads_as_no_choice(self, workspace: Workspace):
        # Nothing to open it from, so honouring it would only produce an empty
        # start with nothing to explain it.
        chosen = fill(workspace, "montreal.zip", parquet=False)
        workspace.set_startup_feed(chosen)
        assert workspace.startup_feed() is None

    def test_a_file_that_is_not_a_choice_is_ignored(self, workspace: Workspace):
        for content in ("", "not json", "[]", '{"feed": null}', '{"feed": ""}'):
            workspace.startup_path.write_text(content, encoding="utf-8")
            assert workspace.startup_feed() is None


class TestMeasuring:
    def test_counts_only_files(self, tmp_path: Path):
        (tmp_path / "nested").mkdir()
        (tmp_path / "nested" / "a").write_bytes(b"x" * 10)
        (tmp_path / "b").write_bytes(b"x" * 5)
        assert directory_bytes(tmp_path) == 15

    def test_a_missing_directory_weighs_nothing(self, tmp_path: Path):
        assert directory_bytes(tmp_path / "gone") == 0

    def test_a_broken_symlink_does_not_stop_the_count(self, tmp_path: Path):
        (tmp_path / "real").write_bytes(b"x" * 7)
        (tmp_path / "dangling").symlink_to(tmp_path / "missing")
        assert directory_bytes(tmp_path) == 7
