"""Guards against the performance regressions this project has actually shipped.

Each one asserts a structural property - how often a file is scanned, what a
feature carries, whether a handler is a coroutine - rather than a duration, so
they are deterministic and cannot flake on a slow runner. Timing lives in
scripts/benchmark.py, which reports and never fails, and browser memory in
tests/browser/, which needs a real browser.

A failure here is a decision to revisit, not a test to delete: every one of
these was a real defect that reached a user. docs/ARCHITECTURE.md records what
each exists to prevent.
"""

from __future__ import annotations

import inspect
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from gtfs_garage.core import geojson as gj
from gtfs_garage.core.feed import GtfsFeed
from gtfs_garage.core.network import route_detail, route_list, route_timetable
from gtfs_garage.core.overview import feed_overview
from gtfs_garage.core.service import calendar_summary
from gtfs_garage.server.app import create_app
from gtfs_garage.server.routes import router


class RecordingCursor:
    """A DuckDB cursor that remembers the SQL it was asked to run."""

    def __init__(self, inner):
        self._inner = inner
        self.statements: list[str] = []

    def execute(self, sql, *args, **kwargs):
        self.statements.append(" ".join(sql.split()))
        self._inner.execute(sql, *args, **kwargs)
        return self

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def sorted_walks_of(self, table: str) -> int:
        """Full ordered passes over a table - the expensive kind of read."""
        return sum(1 for s in self.statements if f"FROM {table} " in s and "ORDER BY" in s)


def drain(batches) -> list[dict]:
    return [feature for batch in batches for feature in batch]


def vertices_in(features: list[dict]) -> int:
    return sum(len(f["geometry"]["coordinates"]) for f in features)


@pytest.fixture()
def recording(feed: GtfsFeed) -> RecordingCursor:
    return RecordingCursor(feed.cursor())


class TestNothingBlocksTheEventLoop:
    def test_no_endpoint_is_a_coroutine(self):
        """A blocking `async def` handler freezes the whole server.

        Every handler here does blocking DuckDB and file I/O. FastAPI runs a
        plain `def` in a worker thread but an `async def` directly on the event
        loop, where it starves every other request for its whole duration -
        which is how a 577 MB feed produced minutes of dead interface.

        If a genuinely non-blocking endpoint is ever added, this has to become
        an allowlist rather than being removed.
        """
        offenders = [
            route.name for route in router.routes if inspect.iscoroutinefunction(getattr(route, "endpoint", None))
        ]
        assert not offenders, f"these run on the event loop and must not block: {offenders}"


class TestFilesAreReadOnce:
    def test_the_routes_layer_walks_shapes_once(self, recording: RecordingCursor):
        """`routes_geojson` used to resolve its routes, then re-query the shapes
        table by id - scanning and sorting the whole file a second time. On a
        large feed that is 299 MB read twice for one map draw."""
        drain(gj.iter_routes(recording))
        assert recording.sorted_walks_of("shapes") == 1

    def test_the_shapes_layer_walks_shapes_once(self, recording: RecordingCursor):
        drain(gj.iter_shapes(recording))
        assert recording.sorted_walks_of("shapes") == 1

    def test_a_layer_costs_the_same_number_of_queries_whatever_the_feed(self, generated_feed):
        """The query count must not grow with the data.

        A per-shape or per-route lookup looks harmless against a small fixture
        and is fatal on a real feed. Comparing two sizes is what catches it -
        every generated shape here belongs to a route, so the routes layer is
        the one doing the work.
        """
        counts = []
        for shapes in (5, 60):
            loaded = GtfsFeed(str(generated_feed(stops=50, shapes=shapes, points_per_shape=8)))
            try:
                cursor = RecordingCursor(loaded.cursor())
                assert drain(gj.iter_routes(cursor)), "nothing drawn, so nothing measured"
                drain(gj.iter_shapes(cursor))
                counts.append(len(cursor.statements))
            finally:
                loaded.close()
        assert counts[0] == counts[1], f"query count grew with the feed: {counts}"


class TestPayloadsStayBounded:
    def test_both_line_layers_share_one_vertex_budget(self, generated_feed, monkeypatch):
        """Budgeting the layers separately lets the map hold twice the intended
        geometry, since both are drawn from shapes.txt into the same heap. That
        is how a tab still reached a gigabyte and died after the first fix.

        Asserted against the budget rather than against the feed: `drawn <=
        total` would hold even with no budget at all.
        """
        budget = 250
        monkeypatch.setattr(gj, "MAX_MAP_VERTICES", budget)
        loaded = GtfsFeed(str(generated_feed(stops=50, shapes=50, points_per_shape=20)))
        try:
            cursor = loaded.cursor()
            features = drain(gj.iter_routes(cursor)) + drain(gj.iter_shapes(cursor))
            drawn = vertices_in(features)
            assert drawn <= budget + 2 * len(features), f"drew {drawn} against a budget of {budget}"
        finally:
            loaded.close()

    def test_a_bigger_feed_is_thinned_harder(self, generated_feed, monkeypatch):
        """The budget is a ceiling on what is drawn, not a ratio of the feed.

        There is one floor beneath it: a line needs two points to exist at all,
        so a feed with many short shapes cannot go below two per shape however
        tight the budget. The invariant is the budget plus that floor - and a
        feed ten times larger must land nowhere near ten times the geometry.
        """
        budget = 100
        monkeypatch.setattr(gj, "MAX_MAP_VERTICES", budget)
        for shapes in (20, 200):
            loaded = GtfsFeed(str(generated_feed(stops=50, shapes=shapes, points_per_shape=20)))
            try:
                cursor = loaded.cursor()
                features = drain(gj.iter_routes(cursor)) + drain(gj.iter_shapes(cursor))
                drawn = vertices_in(features)
                assert drawn <= budget + 2 * len(features), f"{shapes} shapes drew {drawn} vertices"
            finally:
                loaded.close()

    def test_stops_carry_only_the_properties_the_map_reads(self, feed: GtfsFeed):
        """`map.ts` puts stop_name and stop_id in the popup and styles on
        neither. Two properties nobody read once cost tens of megabytes of
        browser memory on a feed with half a million stops.

        Adding one here is a deliberate decision - update the popup too, or the
        cost buys nothing.
        """
        features = drain(gj.iter_stops(feed.cursor()))
        assert {key for f in features for key in f["properties"]} == {"stop_id", "stop_name"}


class TestLayersStream:
    @pytest.fixture()
    def client(self, feed_dir: Path):
        with TestClient(create_app(str(feed_dir))) as running:
            yield running

    def test_a_whole_layer_is_streamed_not_buffered(self, client: TestClient):
        """Built as one document, a large feed's layer is hundreds of MB that
        neither side can hold - and nothing reaches the map until all of it
        has."""
        response = client.get("/api/geojson/stops")
        assert response.headers["content-type"].startswith("application/x-ndjson")

        lines = [json.loads(line) for line in response.text.splitlines() if line]
        # A header first, carrying the total the map counts up to.
        assert lines[0]["type"] == "header"
        assert all(line["type"] == "batch" for line in lines[1:])

    def test_layers_are_compressed(self, client: TestClient):
        """GeoJSON is repetitive text and compresses roughly sevenfold. Without
        this the map payload crosses the wire raw."""
        response = client.get("/api/geojson/stops", headers={"Accept-Encoding": "gzip"})
        assert response.headers.get("content-encoding") == "gzip"


@pytest.fixture()
def watched(explore_feed: GtfsFeed):
    """A feed whose every cursor records the SQL run through it.

    The derived views open their own cursors, so recording one is not enough -
    this replaces the factory, which is the only way to see every statement a
    whole view costs.
    """
    statements: list[str] = []
    original = explore_feed.cursor

    def recording():
        cursor = RecordingCursor(original())
        cursor.statements = statements
        return cursor

    explore_feed.cursor = recording  # type: ignore[method-assign]
    try:
        yield explore_feed, statements
    finally:
        explore_feed.cursor = original  # type: ignore[method-assign]


class TestTheDerivedViewsStayOffTheBigFile:
    """`stop_times.txt` is the file that makes a feed large - tens of millions
    of rows where everything else has thousands. A summary that reads it is a
    summary that stops answering on a real feed, so the three views that open
    first are built not to.
    """

    def test_the_overview_never_reads_stop_times_except_to_count_them(self, watched):
        feed, statements = watched
        feed_overview(feed)
        touching = [s for s in statements if "stop_times" in s]
        assert touching == ["SELECT COUNT(*) FROM stop_times"]

    def test_the_calendar_never_reads_stop_times_at_all(self, watched):
        """A date's trip count is the per-service trip counts summed over the
        services active that day - one small group-by, whatever the feed's size.
        """
        feed, statements = watched
        calendar_summary(feed)
        assert not [s for s in statements if "stop_times" in s]

    def test_the_route_list_never_reads_stop_times_at_all(self, watched):
        feed, statements = watched
        route_list(feed)
        assert not [s for s in statements if "stop_times" in s]

    def test_a_route_card_reaches_stop_times_only_through_its_own_trips(self, watched):
        """The one view that has to read it. Every statement that does is
        filtered to this route's trips and names only the columns it needs, so
        the cost is a filtered scan of two or three columns rather than a read
        of the file.
        """
        feed, statements = watched
        route_detail(feed, "10")

        reads = [s for s in statements if "stop_times" in s]
        assert reads, "the card is expected to read stop_times - this guard is about how"
        for statement in reads:
            assert "trip_id IN (SELECT trip_id FROM route_trips)" in statement
            assert "SELECT st.* " not in statement

    def test_a_timetable_reaches_stop_times_only_through_its_own_route_day(self, watched):
        """The second view that has to read it, and held to the same rule.

        A timetable is a route on a day, so the narrowing by service belongs
        inside the trips CTE rather than as a second pass over the big file.
        """
        from datetime import date

        feed, statements = watched
        route_timetable(feed, "10", date(2026, 1, 1))

        reads = [s for s in statements if "stop_times" in s]
        assert reads, "a timetable is expected to read stop_times - this guard is about how"
        for statement in reads:
            assert "trip_id IN (SELECT trip_id FROM route_trips)" in statement
            assert "SELECT st.* " not in statement
        # One pass, not one per direction or per trip.
        assert len(reads) == 1
