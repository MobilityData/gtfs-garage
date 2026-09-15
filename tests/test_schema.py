"""The schema document is shared with the TypeScript frontend, so these tests
guard both its packaging and its internal consistency.
"""

import json
import tempfile
from pathlib import Path

import pytest

from gtfs_garage.core.schema import (
    ENUM_LIKE_COLUMNS,
    FOREIGN_KEYS,
    TABLES,
    load_schema,
    related_tables,
)


def test_schema_loads_from_the_installed_package():
    # Reads through importlib.resources, so this passes from a wheel too.
    document = load_schema()
    assert set(document) >= {"tables", "enumLikeColumns"}


def test_the_document_is_keyed_by_table_then_field():
    """The shape is what lets per-field facts be added.

    Keyed this way, giving a field a type or a requiredness is a new key on an
    existing record rather than a fourth parallel map - so the readers below,
    and the TypeScript consumer, are unaffected by such an addition.
    """
    fields = TABLES["stops"]
    assert fields["stop_id"]["primaryKey"] is True
    assert fields["parent_station"]["references"] == {"table": "stops", "field": "stop_id"}


def test_a_field_may_carry_facts_the_readers_ignore():
    # Nothing reads "type" yet; the point is that adding it breaks nothing.
    assert all(isinstance(field, dict) for fields in TABLES.values() for field in fields.values())


def test_every_foreign_key_points_at_a_field_that_exists():
    """A reference must resolve, but not necessarily to a primary id.

    GTFS has foreign keys onto secondary columns - `fare_rules.origin_id` names
    `stops.zone_id`, not `stops.stop_id`. Asserting every reference landed on a
    primary id only passed while the schema covered nine tables; it is not true
    of the specification.
    """
    for table, columns in FOREIGN_KEYS.items():
        for column, (target_table, target_column) in columns.items():
            assert target_table in TABLES, f"{table}.{column} references unknown table {target_table}"
            assert (
                target_column in TABLES[target_table]
            ), f"{table}.{column} references {target_table}.{target_column}, which that table does not have"


def test_reverse_links_only_follow_primary_ids():
    # A consequence of the above worth pinning: a reference onto a secondary
    # column gives a forward link but no reverse one, because "rows pointing at
    # this row" is only well defined for a table's own id.
    assert ("fare_rules", "origin_id") not in related_tables("stops")
    assert ("stop_times", "stop_id") in related_tables("stops")


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


class TestAgreementWithTheSpecification:
    """What the schema claims has to match what GTFS says.

    Each of these pins a field whose requiredness or linkage is easy to get
    wrong, so that regenerating the schema cannot quietly change what the
    viewer tells a reader about a feed.
    """

    def test_every_table_the_viewer_can_link_is_described(self):
        # A table with no described fields has no foreign keys, so the viewer
        # shows it as a dead end.
        for table in ("pathways", "transfers", "fare_rules", "areas"):
            assert table in TABLES, f"{table} is not described"
            assert TABLES[table], f"{table} has no fields"

    def test_requiredness_matches_the_specification(self):
        assert TABLES["timeframes"]["timeframe_group_id"]["required"] == "always"
        # Required as a column; an empty value means unlimited transfers.
        assert TABLES["fare_attributes"]["transfers"]["required"] == "always"
        assert TABLES["stop_times"]["start_pickup_drop_off_window"]["required"] == "conditional"
        assert "required" not in TABLES["stops"]["zone_id"]

    def test_service_id_keeps_its_link(self):
        # A service may be defined in calendar.txt or calendar_dates.txt. It is
        # linked to calendar.txt so the viewer offers somewhere to follow.
        assert FOREIGN_KEYS["trips"]["service_id"] == ("calendar", "service_id")

    def test_enumerations_carry_their_values(self):
        route_type = TABLES["routes"]["route_type"]
        assert route_type["type"] == "ENUM"
        assert route_type["values"]["3"] == "Bus"
        # Extended route types (100-1700) are in the spec but not enumerated
        # here, so a renderer must tolerate an unrecognised code.
        assert "700" not in route_type["values"]

    def test_field_types_cover_every_field(self):
        untyped = [
            f"{table}.{name}"
            for table, fields in TABLES.items()
            for name, field in fields.items()
            if "type" not in field
        ]
        assert not untyped, f"fields with no declared type: {untyped}"


def test_the_packaged_json_matches_the_linkml_source():
    """The committed JSON is generated, so it can drift from its source.

    It is committed rather than built because it ships as package data - a
    `pip install` has no LinkML, and the TypeScript side cannot read YAML at
    all. That duplication is only safe if something checks it, which is this:
    regenerate from schema/gtfs.yaml and compare.

    If this fails, run `python scripts/build_schema_json.py`.
    """
    import subprocess
    import sys

    root = Path(__file__).resolve().parent.parent
    source = root / "schema" / "gtfs.yaml"
    if not source.exists():
        pytest.skip("schema/gtfs.yaml is not in this checkout (an installed wheel ships only the JSON)")

    with tempfile.TemporaryDirectory() as scratch:
        regenerated = Path(scratch) / "gtfs-schema.json"
        subprocess.run(
            [
                sys.executable,
                str(root / "scripts" / "build_schema_json.py"),
                "--schema",
                str(source),
                "--out",
                str(regenerated),
            ],
            check=True,
            capture_output=True,
        )
        assert json.loads(regenerated.read_text()) == load_schema(), (
            "src/gtfs_garage/data/gtfs-schema.json is out of date; " "run python scripts/build_schema_json.py"
        )


# --------------------------------------------------------------------------
# Facts the LinkML description carries, and the document is generated from.
# These read the committed document, so they run without LinkML installed.
# --------------------------------------------------------------------------


def _fields():
    for table, columns in TABLES.items():
        for column, field in columns.items():
            yield table, column, field


def test_a_conditionally_required_field_says_what_the_condition_is():
    """ "conditional" on its own is not something a reader can act on.

    Every one of them carries the condition in words, so the UI can explain it
    rather than showing a word that means "it depends".
    """
    silent = [
        f"{table}.{column}"
        for table, column, field in _fields()
        if field.get("required") == "conditional" and not field.get("condition")
    ]
    assert not silent, f"conditionally required with no stated condition: {silent}"


def test_conditions_that_are_not_per_row_are_marked_unenforceable():
    """The honest half of the conditional story.

    Most conditions are a property of a single row and are LinkML `rules`, which
    validate. A few - "required when the feed has more than one agency" - are a
    property of the whole feed, which a per-row rule cannot express. Those are
    recorded in words and flagged, rather than written as a rule that would look
    authoritative and check nothing.
    """
    unenforceable = {
        f"{table}.{column}" for table, column, field in _fields() if field.get("conditionEnforced") is False
    }
    assert unenforceable == {
        "agency.agency_id",
        "fare_attributes.agency_id",
        "routes.agency_id",
        "trips.shape_id",
        "stop_times.arrival_time",
        "stop_times.departure_time",
    }


def test_no_field_is_both_always_and_conditionally_required():
    contradictory = [
        f"{table}.{column}"
        for table, column, field in _fields()
        if field.get("required") == "always" and field.get("condition")
    ]
    assert not contradictory


def test_no_enumeration_is_missing_its_values():
    empty = [
        f"{table}.{column}"
        for table, column, field in _fields()
        if field.get("type") == "ENUM" and not field.get("values")
    ]
    assert not empty, f"enum fields with no values: {empty}"
    assert TABLES["stops"]["location_type"]["values"]["1"] == "Station"


def test_enumerations_are_ordered_by_their_numeric_code():
    """The filter picklist shows them in this order, so 2 must not follow 12."""
    codes = list(TABLES["routes"]["route_type"]["values"])
    assert codes == sorted(codes, key=int)
