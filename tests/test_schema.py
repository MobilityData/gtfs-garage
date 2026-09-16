"""The schema document is shared with the TypeScript frontend, so these tests
guard both its packaging and its internal consistency.
"""

import json
import re
import tempfile
from pathlib import Path

import pytest
import yaml

from gtfs_garage.core.conditions import CHECK_KINDS
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


def test_every_conditional_field_says_what_settles_its_condition():
    """Stated positively, on every one of them.

    The scope was once the absence of a flag, which left "settled by the row"
    and "nobody has said" looking identical. A consumer should not have to read
    silence.
    """
    silent = [
        f"{table}.{column}"
        for table, column, field in _fields()
        if field.get("required") == "conditional" and not field.get("conditionScope")
    ]
    assert not silent, f"conditionally required with no scope: {silent}"


def test_the_conditions_that_reach_outside_their_row_are_exactly_these():
    """The six a LinkML rule cannot express, and which way each escapes it.

    `feed` is answerable once for a whole column; `row_context` varies row by
    row on something the row does not carry. Everything else is a rule.
    """
    by_scope: dict[str, set[str]] = {}
    for table, column, field in _fields():
        scope = field.get("conditionScope")
        if scope and scope != "row":
            by_scope.setdefault(scope, set()).add(f"{table}.{column}")

    assert by_scope == {
        "feed": {"agency.agency_id", "fare_attributes.agency_id", "routes.agency_id"},
        "row_context": {"stop_times.arrival_time", "stop_times.departure_time", "trips.shape_id"},
    }


def test_every_feed_scope_condition_carries_a_check_that_can_be_carried_out():
    """A condition promising an answer must have something that produces one."""
    for table, column, field in _fields():
        if field.get("conditionScope") != "feed":
            continue
        check = field.get("conditionCheck")
        assert check, f"{table}.{column} is feed-scope but carries no check"
        assert check["kind"] in CHECK_KINDS, f"{table}.{column} wants {check['kind']!r}, unimplemented"


def test_a_check_says_what_it_does_rather_than_naming_itself():
    """The document is published for other projects, so a check has to be
    readable without this codebase. `{"kind": "row_count", "file": "agency",
    "minimum": 2}` can be carried out by anything; `more_than_one_agency` could
    only be looked up in a dictionary the reader does not have.
    """
    for table, column, field in _fields():
        check = field.get("conditionCheck")
        if not check:
            continue
        assert isinstance(check, dict), f"{table}.{column} carries a bare check name"
        assert check.get("kind") in CHECK_KINDS, f"{table}.{column}: {check}"
        # Arguments beyond the kind, or it says no more than a name would.
        assert set(check) > {"kind"}, f"{table}.{column} declares a kind with no arguments"


def test_the_agency_checks_say_what_gtfs_says():
    """Read back against the specification: "more than one agency" is two or
    more rows in agency.txt, and nothing else."""
    for table in ("agency", "routes", "fare_attributes"):
        check = TABLES[table]["agency_id"]["conditionCheck"]
        assert check == {"kind": "row_count", "file": "agency", "minimum": 2}


def test_only_a_feed_scope_condition_carries_a_check():
    """A check on any other scope would be an answer nothing asked for."""
    stray = [
        f"{table}.{column}"
        for table, column, field in _fields()
        if field.get("conditionCheck") and field.get("conditionScope") != "feed"
    ]
    assert not stray, f"a check on a scope that cannot use it: {stray}"


def test_no_condition_states_the_same_sentence_twice():
    """A rule naming one slot in both halves used to describe it once per half.

    "Required if X. Forbidden otherwise." came out doubled end to end, in the
    shipped document and in the column header. `stops.parent_station` genuinely
    carries two rules' descriptions, so the guard is against a repeated
    sentence rather than against more than one.
    """
    repeated = []
    for table, column, field in _fields():
        condition = field.get("condition")
        if not condition:
            continue
        sentences = [part.strip(" .") for part in condition.split(". ") if part.strip(" .")]
        if len(sentences) != len(set(sentences)):
            repeated.append(f"{table}.{column}: {condition}")
    assert not repeated, f"condition text repeats itself: {repeated}"


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


# --------------------------------------------------------------------------
# locations.geojson is described twice: as the GeoJSON document it is, and as
# the flat rows the viewer browses. Only the second is a table.
# --------------------------------------------------------------------------


def _linkml() -> dict:
    yaml = pytest.importorskip("yaml")
    source = Path(__file__).resolve().parents[1] / "schema" / "gtfs.yaml"
    if not source.exists():
        pytest.skip("schema/gtfs.yaml is not in this checkout")
    return yaml.safe_load(source.read_text(encoding="utf-8"))


def test_a_contained_class_is_not_a_table():
    """`Feature` and `Geometry` are parts of a document, not files of rows.

    If they leaked into the document the sidebar would list them, and clicking
    one would issue a SQL query for a table that does not exist.
    """
    for name in ("LocationsGeoJson", "Feature", "Geometry", "FeatureProperties"):
        assert name in _linkml()["classes"], f"{name} should be described"
        assert name not in TABLES, f"{name} is contained and must not be a table"


def test_containment_is_not_mistaken_for_a_foreign_key():
    """`range:` means a foreign key for a CSV column and containment for an
    inlined slot. Only the reading that produces a followable link belongs in
    the document."""
    for table, columns in FOREIGN_KEYS.items():
        for column, (target, _) in columns.items():
            assert target in TABLES, f"{table}.{column} links to {target}, which is not a table"


def test_the_browsable_projection_matches_the_document_it_comes_from():
    """The flat `locations` table and the nested `Feature` describe one file, so
    they must not drift: every column is either the Feature's own id, one of its
    properties, or a fact about its geometry."""
    classes = _linkml()["classes"]
    projectable = (
        set(classes["Feature"]["attributes"]) | set(classes["FeatureProperties"]["attributes"]) | {"geometry_type"}
    ) - {"type", "properties"}
    assert set(TABLES["locations"]) <= projectable


def test_stop_times_can_reach_a_zone():
    assert FOREIGN_KEYS["stop_times"]["location_id"] == ("locations", "id")


def test_only_the_geometries_gtfs_permits_are_enumerated():
    assert set(TABLES["locations"]["geometry_type"]["values"]) == {"Polygon", "MultiPolygon"}


# --------------------------------------------------------------------------
# What GTFS says an empty value means. Declared per field, because the spec
# assigns it per field rather than per enumeration.
# --------------------------------------------------------------------------


def _when_empty(table: str, column: str):
    return TABLES[table][column].get("whenEmpty")


def test_an_implied_value_resolves_to_a_code_and_its_label():
    assert _when_empty("stop_times", "pickup_type") == {"code": "0", "label": "Regular"}


def test_the_implied_code_is_not_always_zero():
    """The case a default stored on the enumeration would get wrong.

    `pickup_type` and `continuous_pickup` sit beside each other in the same
    file; a blank in the first means 0 and a blank in the second means 1.
    """
    assert _when_empty("stop_times", "pickup_type")["code"] == "0"
    assert _when_empty("stop_times", "continuous_pickup")["code"] == "1"
    assert _when_empty("routes", "continuous_pickup")["code"] == "1"


def test_a_meaning_with_no_code_is_still_carried():
    """fare_attributes.transfers is Required as a column, and its empty value
    means unlimited transfers - which is not one of its codes, so there is
    nothing for LinkML's `ifabsent` to name."""
    implied = _when_empty("fare_attributes", "transfers")
    assert implied["label"].startswith("Unlimited transfers")
    assert "code" not in implied


def test_a_field_gtfs_says_nothing_about_has_no_implied_value():
    for table, column in (("routes", "route_type"), ("trips", "direction_id")):
        assert _when_empty(table, column) is None


def test_only_a_column_required_field_both_requires_and_implies():
    """If GTFS demands a value, an empty cell is an error rather than a default,
    so the two facts should not meet on one field.

    One field legitimately carries both. `fare_attributes.transfers` is required
    as a *column* while its value may be empty and means unlimited transfers -
    a distinction the document flattens to "always", so it shows up here as the
    single exception rather than as a separate requiredness.
    """
    both = {
        f"{table}.{column}"
        for table, columns in TABLES.items()
        for column, field in columns.items()
        if field.get("required") == "always" and "whenEmpty" in field
    }
    assert both == {"fare_attributes.transfers"}


def test_every_implied_code_is_one_of_the_fields_own_values():
    for table, columns in TABLES.items():
        for column, field in columns.items():
            implied = field.get("whenEmpty")
            if implied and "code" in implied:
                assert implied["code"] in (
                    field.get("values") or {}
                ), f"{table}.{column} implies {implied['code']}, which is not one of its codes"


def _linkml_types() -> dict:
    """The `types` block of the LinkML source, or skip.

    Constraints live only in schema/gtfs.yaml - the packaged document carries
    the GTFS field type a column has, not the shape of its values - so these
    read the source and skip against an installed wheel, as the sync test does.
    """
    source = Path(__file__).resolve().parent.parent / "schema" / "gtfs.yaml"
    if not source.exists():
        pytest.skip("schema/gtfs.yaml is not in this checkout (an installed wheel ships only the JSON)")
    import yaml

    return yaml.safe_load(source.read_text(encoding="utf-8"))["types"]


def test_exactly_these_types_carry_a_constraint():
    """Pinned as a set so adding or removing one is a deliberate act with a
    visible diff rather than something that drifts in.
    """
    types = _linkml_types()
    constrained = {
        name for name, definition in types.items() if {"pattern", "minimum_value", "maximum_value"} & set(definition)
    }
    assert constrained == {
        "COLOR",  # "a six-digit hexadecimal number"
        "DATE",  # "the YYYYMMDD format"
        "TIME",  # "the HH:MM:SS format (H:MM:SS is also accepted)"
        "URL",  # "includes http:// or https://"
        "CURRENCY_CODE",  # "An ISO 4217 alphabetical currency code"
        "TIMEZONE",  # "never contain the space character"
        "LATITUDE",  # "greater than or equal to -90.0 and less than or equal to 90.0"
        "LONGITUDE",  # "greater than or equal to -180.0 and less than or equal to 180.0"
        "EMAIL",
        "INTEGER",
    }


def test_every_constraint_accepts_what_its_own_description_describes():
    """A pattern that rejected the reference's own wording would be a bug in the
    schema, not in a feed."""
    import re

    types = _linkml_types()
    for type_name, value in [
        ("COLOR", "FFFFFF"),
        ("COLOR", "00aabb"),
        ("DATE", "20260822"),
        ("TIME", "25:30:00"),  # past midnight, which GTFS explicitly allows
        ("TIME", "8:30:00"),  # H:MM:SS, which the description accepts
        ("URL", "https://example.org"),
        ("CURRENCY_CODE", "EUR"),
        ("TIMEZONE", "America/Argentina/Buenos_Aires"),  # underscores are allowed
        ("INTEGER", "5"),
        ("INTEGER", "-3"),
        ("INTEGER", "0"),
    ]:
        assert re.match(types[type_name]["pattern"], value), f"{type_name} rejects {value!r}"

    for type_name, value in [
        ("COLOR", "#FFFFFF"),
        ("DATE", "2026-08-22"),
        ("TIMEZONE", "America/New York"),
        # An integer has no fractional part, so these are not integers however
        # readily Number() parses them.
        ("INTEGER", "1.5"),
        ("INTEGER", "2e3"),
    ]:
        assert not re.match(types[type_name]["pattern"], value), f"{type_name} accepts {value!r}"


def test_the_published_field_types_match_the_linkml_they_came_from():
    """The guard against the generator drifting from the source.

    The viewer applies these patterns, so a constraint that reached the document
    in a different shape from the one the schema states would be enforced
    without ever having been written down.
    """
    types = _linkml_types()
    published = load_schema()["fieldTypes"]

    expected = {}
    for name, definition in types.items():
        entry = {"description": definition["description"]}
        if definition.get("pattern"):
            entry["pattern"] = definition["pattern"]
        for source, key in (("minimum_value", "minimum"), ("maximum_value", "maximum")):
            if definition.get(source) is not None:
                entry[key] = definition[source]
        expected[name] = entry

    assert published == expected


def test_every_type_a_field_uses_is_published():
    """A field naming a type the document does not describe would be a column
    the viewer could not check or explain."""
    published = load_schema()["fieldTypes"]
    used = {field["type"] for _, _, field in _fields() if field.get("type")}
    # ENUM and ID are produced from a `range` pointing at an enum or a class
    # rather than from the types block, so they have no entry to find.
    assert not (used - set(published)) - {"ENUM"}, f"types used but not published: {used - set(published)}"


# Characters a pattern may use: anchors, character classes, escapes, grouping,
# alternation, and quantifiers that are not nested. Anything else has to be
# added here deliberately.
SAFE_PATTERN = re.compile(r"^[\^\$\w\\\-\[\]\{\},\.\|\(\)\+\*\?/:@ ]+$")
NESTED_QUANTIFIER = re.compile(r"[+*}]\s*[+*]|\)[+*]\s*[+*]|\([^)]*[+*][^)]*\)[+*]")


def test_every_published_pattern_is_safe_to_compile_and_run():
    """These cross a language boundary: the browser compiles them with
    `new RegExp` and runs them over every visible cell.

    Two hazards. A construct that means different things to Python and
    JavaScript would enforce two rules from one declaration, so the syntax is
    held to a common subset. A nested quantifier can backtrack catastrophically,
    so a feed could hang the viewer with one cell.
    """
    for name, published in load_schema()["fieldTypes"].items():
        pattern = published.get("pattern")
        if not pattern:
            continue
        assert SAFE_PATTERN.match(pattern), f"{name} uses syntax outside the agreed subset: {pattern}"
        assert not NESTED_QUANTIFIER.search(pattern), f"{name} can backtrack catastrophically: {pattern}"
        re.compile(pattern)


def test_the_feed_holds_every_file_and_nothing_else():
    """The containment rewrite's guard.

    Adding a Feed that inlines all 31 files made every class contained, which
    would have deleted every table from the viewer. The rule that separates
    "the feed holds its files" from "a structure holds its parts" is easy to
    break silently, so the table set is pinned.
    """
    tables = set(load_schema()["tables"])
    assert len(tables) == 32
    # The four that describe locations.geojson's structure, and the feed itself,
    # are not files of rows.
    types_and_structures = {"Feed", "LocationsGeoJson", "Feature", "FeatureProperties", "Geometry"}
    assert not tables & types_and_structures
    # `locations` is the flat projection the viewer browses, so it is a table
    # even though it is not a CSV file.
    assert "locations" in tables


def test_the_schema_has_exactly_one_root():
    """Two `tree_root` classes generate without error and one silently wins,
    taking over the generated JSON Schema's root."""
    classes = yaml.safe_load(
        (Path(__file__).resolve().parent.parent / "schema" / "gtfs.yaml").read_text(encoding="utf-8")
    )["classes"]
    roots = [name for name, cls in classes.items() if cls.get("tree_root")]
    assert roots == ["Feed"]


def test_every_file_says_whether_a_feed_must_contain_it():
    presence = {table: entry.get("presence") for table, entry in load_schema()["tables"].items()}
    silent = sorted(name for name, value in presence.items() if not value)
    assert not silent, f"files with no stated presence: {silent}"


def test_the_files_gtfs_requires_are_exactly_these():
    """Read off the reference file by file. Pinned so a fifth cannot appear
    unnoticed - a file wrongly marked required is reported missing from every
    feed that does not have it."""
    tables = load_schema()["tables"]
    required = {name for name, entry in tables.items() if entry.get("presence") == "required"}
    assert required == {"agency", "routes", "trips", "stop_times"}

    conditional = {name for name, entry in tables.items() if entry.get("presence") == "conditional"}
    assert conditional == {"stops", "calendar", "calendar_dates", "levels", "feed_info"}


CONDITIONAL_PRESENCE = ("conditional", "conditionally_forbidden")


def test_every_file_condition_can_actually_be_answered():
    """`scope: feed` means one answer settles this for the whole file. A
    condition carrying that label and no check promises an answer nothing can
    produce - prose wearing a machine-readable badge."""
    for table, entry in load_schema()["tables"].items():
        if entry.get("presence") not in CONDITIONAL_PRESENCE:
            continue
        assert entry.get("condition"), f"{table} is conditional with no stated condition"
        assert entry.get("conditionScope") == "feed"
        check = entry.get("conditionCheck")
        assert check, f"{table} claims scope 'feed' but carries no check"
        assert check["kind"] in CHECK_KINDS, f"{table} wants {check['kind']!r}, unimplemented"


def test_the_files_gtfs_forbids_are_exactly_these():
    """Direction is a separate fact from conditionality, and getting it wrong
    is silent: a forbidden file whose check holds would be reported as missing
    and needed, when GTFS says the feed should not have it at all."""
    tables = load_schema()["tables"]
    forbidden = {n for n, e in tables.items() if e.get("presence") == "conditionally_forbidden"}
    assert forbidden == {"networks", "route_networks"}


def test_presence_is_one_of_the_four_values_gtfs_uses():
    values = {entry.get("presence") for entry in load_schema()["tables"].values()}
    assert values == {"required", "optional", "conditional", "conditionally_forbidden"}
