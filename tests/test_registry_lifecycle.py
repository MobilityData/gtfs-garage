"""Loading a feed while requests are reading the previous one.

Requests genuinely run concurrently now that `POST /api/load` is a plain `def`
and so runs in a worker thread. Replacing a feed drops its DuckDB connection
and deletes the files behind it, so a reader that is still mid-query has to
keep the old feed alive until it is done.
"""

from __future__ import annotations

import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from gtfs_garage.server import state as state_module
from gtfs_garage.server.app import create_app
from gtfs_garage.server.state import FeedRegistry, NoFeedLoadedError


@pytest.fixture()
def registry(feed_dir: Path):
    made = FeedRegistry()
    made.load(str(feed_dir))
    yield made
    made.close()


class TestReaderGuard:
    def test_hands_out_the_current_feed(self, registry: FeedRegistry):
        with registry.reading() as feed:
            assert feed is registry.current()

    def test_a_replaced_feed_survives_until_its_reader_finishes(self, registry: FeedRegistry, feed_dir: Path):
        with registry.reading() as old:
            registry.load(str(feed_dir))
            assert registry.current() is not old
            # The query the reader came for still has to work: its cursor is
            # into this connection and its files.
            assert old.row_count("stops") == 3
        # Once the reader lets go there is nothing left to protect.
        with pytest.raises(Exception):
            old.row_count("stops")

    def test_a_replaced_feed_closes_at_once_when_unread(self, registry: FeedRegistry, feed_dir: Path):
        previous = registry.current()
        registry.load(str(feed_dir))
        with pytest.raises(Exception):
            previous.row_count("stops")

    def test_reading_without_a_feed_is_refused(self):
        empty = FeedRegistry()
        with pytest.raises(NoFeedLoadedError):
            with empty.reading():
                pass

    def test_close_releases_a_retired_feed_too(self, feed_dir: Path):
        made = FeedRegistry()
        made.load(str(feed_dir))
        with made.reading():
            retired = made.current()
            made.load(str(feed_dir))
        made._retired.append((retired, 1))  # a reader that never returned
        made.close()
        assert made._retired == []


class TestConcurrentRequests:
    def test_a_load_does_not_block_other_requests(self, feed_dir: Path, monkeypatch):
        """The regression test for the freeze.

        `POST /api/load` used to be an `async def` whose body was entirely
        blocking, so it held the event loop and nothing else could be served
        for the whole load - a 577 MB feed meant minutes of dead interface.

        Asserted as an ordering rather than a duration, so it is a real signal
        on a slow machine: the unrelated request has to be answered *before*
        the load it overlaps with finishes. The fixture feed opens in
        milliseconds, so the load is held open deliberately; without that there
        is no window to be starved of and the test cannot see the bug.
        """
        entered, release = threading.Event(), threading.Event()
        real_feed = state_module.GtfsFeed
        order: list[str] = []

        def slow_feed(*args, **kwargs):
            entered.set()
            # Bounded so a regression fails the assertion rather than hanging.
            release.wait(timeout=5)
            return real_feed(*args, **kwargs)

        monkeypatch.setattr(state_module, "GtfsFeed", slow_feed)

        with TestClient(create_app(str(feed_dir))) as client:

            def load() -> None:
                client.post("/api/load", params={"path": str(feed_dir)})
                order.append("load")

            loader = threading.Thread(target=load, daemon=True)
            loader.start()
            assert entered.wait(timeout=5), "the load never started"

            assert client.get("/api/config").status_code == 200
            order.append("config")
            release.set()
            loader.join(timeout=10)

        assert order == ["config", "load"], "the load monopolised the server while it ran"

    def test_the_feed_stays_queryable_across_a_reload(self, feed_dir: Path):
        with TestClient(create_app(str(feed_dir))) as client:
            client.post("/api/load", params={"path": str(feed_dir)})
            assert client.get("/api/table/stops").json()["total"] == 3
