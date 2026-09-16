import pytest

from gtfs_garage.core.feed import GtfsFeed
from gtfs_garage.core.queries import (
    UnknownColumnError,
    UnknownTableError,
    distinct_values,
    query_table,
    table_summaries,
)


def summary_for(feed: GtfsFeed, table: str) -> dict:
    return next(t for t in table_summaries(feed) if t["name"] == table)


def column_for(feed: GtfsFeed, table: str, column: str) -> dict:
    return next(c for c in summary_for(feed, table)["columns"] if c["name"] == column)


class TestTableSummaries:
    def test_reports_row_counts(self, feed: GtfsFeed):
        assert summary_for(feed, "stops")["row_count"] == 3

    def test_marks_a_resolvable_foreign_key(self, feed: GtfsFeed):
        agency = column_for(feed, "routes", "agency_id")
        assert (agency["fk_table"], agency["fk_column"]) == ("agency", "agency_id")

    def test_offers_reverse_links_from_a_primary_id(self, feed: GtfsFeed):
        related = column_for(feed, "routes", "route_id")["related"]
        assert {"table": "trips", "column": "route_id"} in related

    def test_drops_links_to_files_the_feed_does_not_have(self, feed: GtfsFeed):
        # The fixture has no fare_rules.txt, so routes must not offer that link.
        related = column_for(feed, "routes", "route_id")["related"]
        assert all(link["table"] != "fare_rules" for link in related)

    def test_related_is_always_a_list_even_for_ordinary_columns(self, feed: GtfsFeed):
        assert column_for(feed, "routes", "route_short_name")["related"] == []

    def test_answers_a_feed_scope_condition_against_the_feed(self, feed: GtfsFeed):
        """The fixture has one agency, so the answer is "not required here" -
        and the evidence is what shows the check ran rather than defaulted."""
        agency_id = column_for(feed, "routes", "agency_id")
        assert agency_id["condition_scope"] == "feed"
        assert agency_id["condition_outcome"] == {"holds": False, "evidence": "agency.txt has 1 row"}
        # The rule is kept beside the answer: a reader who doubts the answer
        # needs to see what produced it.
        assert "more than one agency" in agency_id["condition"]

    def test_claims_no_answer_for_a_condition_that_varies_by_row(self, feed: GtfsFeed):
        arrival = column_for(feed, "stop_times", "arrival_time")
        assert arrival["condition_scope"] == "row_context"
        assert arrival["condition_outcome"] is None

    def test_leaves_a_per_row_condition_to_the_row(self, feed: GtfsFeed):
        short_name = column_for(feed, "routes", "route_short_name")
        assert short_name["condition_scope"] == "row"
        assert short_name["condition_outcome"] is None

    def test_says_nothing_about_a_field_that_is_not_conditional(self, feed: GtfsFeed):
        route_type = column_for(feed, "routes", "route_type")
        assert route_type["required"] == "always"
        assert (route_type["condition_scope"], route_type["condition_outcome"]) == (None, None)

    def test_carries_the_shape_a_value_of_this_type_must_have(self, feed: GtfsFeed):
        """Flattened from the document's `fieldTypes` onto each column, so the
        UI applies the schema's rule instead of keeping a copy of it."""
        url = column_for(feed, "agency", "agency_url")
        assert url["pattern"] == "^https?://"
        assert url["type_description"].startswith("A fully qualified URL")

    def test_carries_bounds_for_a_numeric_type(self, feed: GtfsFeed):
        latitude = column_for(feed, "stops", "stop_lat")
        assert (latitude["minimum"], latitude["maximum"]) == (-90, 90)
        assert latitude["pattern"] is None

    def test_says_nothing_about_a_type_gtfs_leaves_open(self, feed: GtfsFeed):
        name = column_for(feed, "stops", "stop_name")
        assert (name["pattern"], name["minimum"], name["maximum"]) == (None, None, None)
        assert name["type_description"].startswith("A string of UTF-8 characters")

    def test_flags_enumerated_columns_for_the_picklist(self, feed: GtfsFeed):
        assert column_for(feed, "routes", "route_type")["enum_like"] is True
        assert column_for(feed, "routes", "route_long_name")["enum_like"] is False


class TestQueryTable:
    def test_returns_columns_rows_and_total(self, feed: GtfsFeed):
        page = query_table(feed, "stops")
        assert page["total"] == 3
        assert len(page["rows"]) == 3
        assert page["columns"][0] == "stop_id"

    def test_paginates(self, feed: GtfsFeed):
        first = query_table(feed, "stop_times", page=1, page_size=2)
        second = query_table(feed, "stop_times", page=2, page_size=2)
        assert first["total"] == second["total"] == 6
        assert len(first["rows"]) == len(second["rows"]) == 2
        assert first["rows"] != second["rows"]

    def test_total_counts_all_matches_not_just_the_page(self, feed: GtfsFeed):
        page = query_table(feed, "stop_times", page=1, page_size=1)
        assert page["total"] == 6
        assert len(page["rows"]) == 1

    def test_applies_filters(self, feed: GtfsFeed):
        page = query_table(feed, "trips", [{"column": "route_id", "op": "eq", "value": "R1"}])
        assert page["total"] == 2

    def test_empty_filter_matches_the_null_rows(self, feed: GtfsFeed):
        # The regression that made the "(empty)" picklist entry match nothing.
        page = query_table(feed, "stop_times", [{"column": "pickup_type", "op": "eq", "value": ""}])
        assert page["total"] == 2

    def test_unknown_table_raises(self, feed: GtfsFeed):
        with pytest.raises(UnknownTableError):
            query_table(feed, "no_such_table")


class TestDistinctValues:
    def test_returns_values_with_counts_most_common_first(self, feed: GtfsFeed):
        values = distinct_values(feed, "stop_times", "pickup_type")
        assert values[0]["count"] >= values[-1]["count"]
        assert sum(v["count"] for v in values) == 6

    def test_empty_values_are_reported_as_none_not_empty_string(self, feed: GtfsFeed):
        # The frontend relies on this to label the entry "(empty)".
        values = {v["value"]: v["count"] for v in distinct_values(feed, "stop_times", "pickup_type")}
        assert values[None] == 2

    def test_unknown_column_raises(self, feed: GtfsFeed):
        with pytest.raises(UnknownColumnError):
            distinct_values(feed, "stops", "not_a_column")

    def test_unknown_table_raises(self, feed: GtfsFeed):
        with pytest.raises(UnknownTableError):
            distinct_values(feed, "no_such_table", "stop_id")
