from gtfs_garage.core.filters import build_where

COLUMNS = {"route_id", "route_type", "continuous_pickup"}


def test_no_filters_produces_no_clause():
    assert build_where(COLUMNS, []) == ("", [])


def test_equality_binds_the_value_as_a_parameter():
    sql, params = build_where(COLUMNS, [{"column": "route_id", "op": "eq", "value": "R1"}])
    assert sql == 'WHERE "route_id" = ?'
    assert params == ["R1"]


def test_multiple_filters_are_combined_with_and():
    sql, params = build_where(
        COLUMNS,
        [
            {"column": "route_id", "op": "eq", "value": "R1"},
            {"column": "route_type", "op": "ne", "value": "3"},
        ],
    )
    assert sql == 'WHERE "route_id" = ? AND "route_type" != ?'
    assert params == ["R1", "3"]


def test_contains_wraps_the_value_in_wildcards():
    sql, params = build_where(COLUMNS, [{"column": "route_id", "op": "contains", "value": "R"}])
    assert sql == 'WHERE "route_id" ILIKE ?'
    assert params == ["%R%"]


def test_in_splits_on_commas_and_ignores_blanks():
    sql, params = build_where(COLUMNS, [{"column": "route_id", "op": "in", "value": "R1, R2, ,"}])
    assert sql == 'WHERE "route_id" IN (?, ?)'
    assert params == ["R1", "R2"]


def test_in_with_no_usable_values_is_dropped():
    assert build_where(COLUMNS, [{"column": "route_id", "op": "in", "value": " , "}]) == ("", [])


def test_unknown_columns_are_ignored_rather_than_interpolated():
    # Column names are never taken from user input; anything unrecognised is dropped.
    sql, params = build_where(COLUMNS, [{"column": 'x"; DROP TABLE routes; --', "op": "eq", "value": "1"}])
    assert sql == ""
    assert params == []


def test_unknown_operator_is_ignored():
    assert build_where(COLUMNS, [{"column": "route_id", "op": "regex", "value": "R"}]) == ("", [])


class TestEmptyValueSemantics:
    """Empty CSV fields load as NULL, so `= (empty)` must be a null-or-empty test.

    Regression: comparing with `= ''` matched nothing, so picking the "(empty)"
    entry out of a value picklist silently returned zero rows.
    """

    def test_equals_empty_becomes_is_empty(self):
        sql, params = build_where(COLUMNS, [{"column": "continuous_pickup", "op": "eq", "value": ""}])
        assert sql == 'WHERE ("continuous_pickup" IS NULL OR "continuous_pickup" = \'\')'
        assert params == []

    def test_not_equals_empty_becomes_is_not_empty(self):
        sql, params = build_where(COLUMNS, [{"column": "continuous_pickup", "op": "ne", "value": ""}])
        assert sql == 'WHERE ("continuous_pickup" IS NOT NULL AND "continuous_pickup" != \'\')'
        assert params == []

    def test_equals_none_is_treated_the_same_as_empty_string(self):
        sql, _ = build_where(COLUMNS, [{"column": "continuous_pickup", "op": "eq", "value": None}])
        assert "IS NULL" in sql

    def test_explicit_is_empty_operator_needs_no_value(self):
        sql, params = build_where(COLUMNS, [{"column": "continuous_pickup", "op": "is_empty"}])
        assert sql == 'WHERE ("continuous_pickup" IS NULL OR "continuous_pickup" = \'\')'
        assert params == []
