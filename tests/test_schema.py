"""The schema document is shared with the TypeScript frontend, so these tests
guard both its packaging and its internal consistency.
"""

from gtfs_garage.core.schema import (
    ENUM_LIKE_COLUMNS,
    FOREIGN_KEYS,
    PRIMARY_ID_COLUMNS,
    load_schema,
    related_tables,
)


def test_schema_loads_from_the_installed_package():
    # Reads through importlib.resources, so this passes from a wheel too.
    document = load_schema()
    assert set(document) >= {"foreignKeys", "primaryIdColumns", "enumLikeColumns"}


def test_every_foreign_key_points_at_a_known_primary_id():
    for table, columns in FOREIGN_KEYS.items():
        for column, (target_table, target_column) in columns.items():
            assert PRIMARY_ID_COLUMNS.get(target_table) == target_column, (
                f"{table}.{column} references {target_table}.{target_column}, " "which is not that table's primary id"
            )


def test_related_tables_finds_the_reverse_direction():
    related = dict(related_tables("routes"))
    assert related["trips"] == "route_id"
    assert related["fare_rules"] == "route_id"


def test_related_tables_excludes_a_tables_own_primary_id():
    # stops.parent_station points at stops.stop_id; stop_id itself is not "related".
    assert ("stops", "stop_id") not in related_tables("stops")
    assert ("stops", "parent_station") in related_tables("stops")


def test_related_tables_is_empty_for_a_table_without_a_primary_id():
    assert related_tables("stop_times") == []
    assert related_tables("not_a_gtfs_table") == []


def test_enum_like_columns_include_the_continuous_fields():
    assert {"continuous_pickup", "continuous_drop_off", "route_type"} <= ENUM_LIKE_COLUMNS
