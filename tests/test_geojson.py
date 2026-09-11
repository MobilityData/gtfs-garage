"""Building map layers from a loaded feed.

The batch generators are what the map actually uses; a whole-feed layer runs to
hundreds of MB on a large feed, so it is streamed rather than assembled. The
one-piece builders remain for the small id-filtered highlight requests.
"""

from __future__ import annotations

import pytest

from gtfs_garage.core import geojson as gj
from gtfs_garage.core.feed import GtfsFeed


@pytest.fixture()
def con(feed: GtfsFeed):
    return feed.cursor()


@pytest.fixture()
def variant(feed_dir, tmp_path):
    """The fixture feed with one file replaced, for the optional-column cases."""
    import shutil

    def build(filename: str, contents: str) -> GtfsFeed:
        directory = tmp_path / "variant"
        directory.mkdir(exist_ok=True)
        for source in feed_dir.glob("*.txt"):
            shutil.copy(source, directory / source.name)
        (directory / filename).write_text(contents, encoding="utf-8")
        return GtfsFeed(str(directory))

    return build


def drain(batches) -> list[dict]:
    return [feature for batch in batches for feature in batch]


class TestStops:
    def test_every_stop_becomes_a_point(self, con):
        features = drain(gj.iter_stops(con))
        assert len(features) == 3
        assert {f["geometry"]["type"] for f in features} == {"Point"}

    def test_the_declared_total_is_what_gets_emitted(self, con):
        # The map counts up to this number, so an unreachable total would leave
        # the progress readout stuck short of the end.
        assert gj.count_stops(con) == len(drain(gj.iter_stops(con)))

    def test_batches_match_the_one_piece_builder(self, con):
        assert drain(gj.iter_stops(con)) == gj.stops_geojson(con)["features"]

    def test_coordinates_are_rounded_to_metre_precision(self, con):
        lon, lat = drain(gj.iter_stops(con))[0]["geometry"]["coordinates"]
        assert round(lon, gj.COORD_PRECISION) == lon
        assert round(lat, gj.COORD_PRECISION) == lat


class TestRoutes:
    def test_a_route_carries_what_the_map_styles_on(self, con):
        properties = drain(gj.iter_routes(con))[0]["properties"]
        assert properties["route_id"] == "R1"
        assert properties["route_color"] == "FF0000"
        # Absent until now, which silently drew every route at default width.
        assert properties["route_type"] == "1"

    def test_a_route_without_its_own_colour_gets_a_default(self, variant):
        # route_color is optional in GTFS, and an uncoloured line still has to
        # be drawn as something.
        header = "route_id,agency_id,route_short_name,route_long_name,route_type"
        loaded = variant("routes.txt", f"{header}\nR1,A1,1,Red Line,1\n")
        try:
            assert drain(gj.iter_routes(loaded.cursor()))[0]["properties"]["route_color"] == "3388ff"
        finally:
            loaded.close()

    def test_a_feed_with_no_routes_yields_an_empty_layer(self, variant):
        loaded = variant("routes.txt", "route_id,agency_id,route_short_name,route_long_name,route_type\n")
        try:
            cursor = loaded.cursor()
            assert drain(gj.iter_routes(cursor)) == []
            assert gj.count_routes(cursor) == 0
        finally:
            loaded.close()

    def test_the_declared_total_is_what_gets_emitted(self, con):
        assert gj.count_routes(con) == len(drain(gj.iter_routes(con)))

    def test_matches_the_one_piece_builder(self, con):
        assert drain(gj.iter_routes(con)) == gj.routes_geojson(con)["features"]


class TestShapes:
    def test_omits_shapes_a_route_already_draws(self, con):
        drawn = {f["properties"]["shape_id"] for f in drain(gj.iter_routes(con))}
        remaining = {f["properties"]["shape_id"] for f in drain(gj.iter_shapes(con))}
        # Sending both meant downloading and parsing each route's shape twice
        # before throwing one copy away in the browser.
        assert drawn and not drawn & remaining

    def test_the_declared_total_is_what_gets_emitted(self, con):
        assert gj.count_shapes(con) == len(drain(gj.iter_shapes(con)))

    def test_a_shape_keeps_its_points_in_sequence(self, con):
        collection = gj.shapes_geojson(con, ["SH1"])
        coordinates = collection["features"][0]["geometry"]["coordinates"]
        assert len(coordinates) >= 2
        assert coordinates == sorted(coordinates, key=lambda c: c[1])

    def test_an_unclaimed_shape_is_actually_drawn(self, variant):
        """The layer must produce features, not just run without error.

        These builders fall back to an empty collection on any exception, so a
        plain programming error - a wrong argument count, say - turns the whole
        shapes layer into silence that no other test notices. Asserting a
        non-empty result for a feed that has an unclaimed shape is what makes
        that visible.
        """
        loaded = variant(
            "shapes.txt",
            "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n"
            "SH1,45.5017,-73.5673,1\nSH1,45.5088,-73.5540,2\n"
            "SH9,45.6000,-73.6000,1\nSH9,45.6100,-73.6100,2\n",
        )
        try:
            features = drain(gj.iter_shapes(loaded.cursor()))
            # SH1 belongs to route R1 and is drawn by the routes layer; SH9 is
            # this layer's whole job.
            assert [f["properties"]["shape_id"] for f in features] == ["SH9"]
        finally:
            loaded.close()

    def test_a_one_point_shape_is_not_a_line(self, feed: GtfsFeed):
        feed.con.execute("CREATE OR REPLACE TEMP VIEW shapes AS SELECT * FROM shapes WHERE shape_pt_sequence = '1'")
        assert drain(gj.iter_shapes(feed.cursor())) == []


class TestMissingFiles:
    def test_a_feed_without_shapes_yields_no_geometry(self, feed_dir, tmp_path):
        import shutil

        trimmed = tmp_path / "feed"
        trimmed.mkdir()
        for source in feed_dir.glob("*.txt"):
            if source.name != "shapes.txt":
                shutil.copy(source, trimmed / source.name)
        loaded = GtfsFeed(str(trimmed))
        try:
            cursor = loaded.cursor()
            # Most GTFS files are optional; a missing one is an empty layer,
            # not a failed request.
            assert drain(gj.iter_shapes(cursor)) == []
            assert gj.count_shapes(cursor) == 0
            assert len(drain(gj.iter_stops(cursor))) == 3
        finally:
            loaded.close()


class TestVertexBudget:
    """Shape geometry is thinned to fit a browser, by a feed-independent rule.

    The step is derived from the layer's own vertex count against
    `MAX_MAP_VERTICES`; nothing here knows which feed it is looking at, so a
    feed that grows is reduced further by the same arithmetic.
    """

    def test_a_small_feed_keeps_every_vertex(self, con):
        assert gj.vertex_step(con) == 1

    def test_the_step_is_the_feed_over_the_budget(self, con, monkeypatch):
        total = con.execute("SELECT COUNT(*) FROM shapes").fetchone()[0]

        # A budget the feed fits inside leaves it alone; halving the budget
        # doubles the step. The rule is arithmetic on the feed's own shapes.txt,
        # so a feed ten times larger is simply reduced ten times harder.
        for budget, expected in ((total, 1), (total * 2, 1), (1, total)):
            monkeypatch.setattr(gj, "MAX_MAP_VERTICES", budget)
            assert gj.vertex_step(con) == expected, f"budget {budget}"

    def test_thinning_keeps_the_ends_of_a_line(self):
        line = [[float(i), 0.0] for i in range(10)]
        thinned = gj._thin(line, 4)
        assert thinned[0] == line[0]
        # Without the last point a route would stop short of where it ends.
        assert thinned[-1] == line[-1]
        assert len(thinned) < len(line)

    def test_thinning_never_destroys_a_line(self):
        # Two points are the minimum for a LineString, so they are never cut.
        assert gj._thin([[0.0, 0.0], [1.0, 1.0]], 8) == [[0.0, 0.0], [1.0, 1.0]]

    def test_a_step_of_one_changes_nothing(self):
        line = [[float(i), 0.0] for i in range(5)]
        assert gj._thin(line, 1) == line

    def test_no_shape_is_dropped_however_hard_it_thins(self, con, monkeypatch):
        before = {f["properties"]["shape_id"] for f in drain(gj.iter_shapes(con))}
        monkeypatch.setattr(gj, "MAX_MAP_VERTICES", 1)
        after = drain(gj.iter_shapes(con))
        # Detail goes; shapes do not.
        assert {f["properties"]["shape_id"] for f in after} == before
        assert all(len(f["geometry"]["coordinates"]) >= 2 for f in after)

    def test_both_line_layers_share_one_budget(self, con, monkeypatch):
        # Budgeting routes and shapes separately would let the map hold twice
        # the intended geometry, since both are drawn into the same heap.
        monkeypatch.setattr(gj, "MAX_MAP_VERTICES", 1)
        routes = sum(len(f["geometry"]["coordinates"]) for f in drain(gj.iter_routes(con)))
        shapes = sum(len(f["geometry"]["coordinates"]) for f in drain(gj.iter_shapes(con)))
        total = con.execute("SELECT COUNT(*) FROM shapes").fetchone()[0]
        assert routes + shapes <= total

    def test_the_step_is_published_so_the_map_can_say_so(self, con, monkeypatch):
        assert gj.shape_step(con) == 1
        monkeypatch.setattr(gj, "MAX_MAP_VERTICES", 1)
        assert gj.shape_step(con) > 1
