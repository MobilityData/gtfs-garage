#!/usr/bin/env python
"""Generate the packaged schema document from the LinkML description.

`schema/gtfs.yaml` is the source of truth. This flattens it into the compact
JSON that ships as package data, so that neither `pip install gtfs-garage` nor
the TypeScript build needs LinkML at runtime - it is a development dependency
only, and the generated file is committed.

The flattening is mostly a matter of resolving `range`, which in the LinkML
carries three different kinds of fact:

    range: RouteType   -> an enum      -> type ENUM, plus its permissible values
    range: stops       -> a class      -> type ID, plus a foreign key to its key
    range: LATITUDE    -> a type       -> that type, and what its values look like

The types themselves are published alongside, under `fieldTypes`, so that what a
value must look like travels with the document rather than being reimplemented
by each consumer. Stated once per type rather than copied onto all 223 fields:
the LinkML states them once, and LATITUDE alone is used by many.

Run after editing the LinkML:

    scripts/build-schema-json.sh
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import yaml

COMMENT = (
    "GTFS relational and field semantics, shared by the Python backend "
    "(core/schema.py) and any JavaScript/TypeScript consumer. Keyed by table, "
    "then by field, so per-field facts have somewhere to live. A field's "
    "\"type\" names an entry in \"fieldTypes\", which carries what a value of "
    "that type must look like. "
    "GENERATED from schema/gtfs.yaml by scripts/build_schema_json.py - edit that, "
    "not this. Keys are camelCase so this reads naturally from TypeScript."
)

def annotation(slot: dict, name: str):
    """LinkML annotations survive as either a scalar or a {value: ...} record
    depending on how they were written; accept both."""
    annotations = slot.get("annotations") or {}
    value = annotations.get(name)
    if isinstance(value, dict):
        return value.get("value")
    return value


def nested_annotations(slot: dict, name: str) -> dict:
    """The annotations carried *by* an annotation.

    LinkML lets an annotation have its own, which is how `gtfs_condition` keeps
    a condition and what it depends on together, rather than as flat siblings a
    reader has to know to group.
    """
    declared = (slot.get("annotations") or {}).get(name)
    if not isinstance(declared, dict):
        return {}
    return {
        key: value.get("value") if isinstance(value, dict) else value
        for key, value in (declared.get("annotations") or {}).items()
    }


# What each kind of check needs to be acted on. The kind is the vocabulary a
# consumer implements; the parameters are what distinguish one field's check
# from another's.
CHECK_PARAMETERS = {"row_count": ("file", "minimum")}


def condition_check(facts: dict) -> dict | None:
    """A feed-scope condition's check, as a record that says what it does.

    `kind` is the sort of question, the rest are its arguments: `row_count` on
    file `agency` with minimum 2 is "holds when agency.txt has two or more
    rows", which anything reading the document can carry out.
    """
    kind = facts.get("check")
    if not kind:
        return None
    if kind not in CHECK_PARAMETERS:
        raise ValueError(f"unknown check kind {kind!r}")
    missing = [p for p in CHECK_PARAMETERS[kind] if facts.get(p) is None]
    if missing:
        raise ValueError(f"check {kind!r} is missing {', '.join(missing)}")
    return {"kind": kind, **{p: facts[p] for p in CHECK_PARAMETERS[kind]}}


def field_types(types: dict) -> dict[str, dict]:
    """GTFS's field types with what a value of each must look like.

    The constraints are the LinkML's own - `pattern`, `minimum_value`,
    `maximum_value` - and each restates a format the reference spells out, so
    "a color encoded as a six-digit hexadecimal number" travels as a regex
    rather than as a sentence every consumer has to read and reimplement. The
    description is carried too, being GTFS's own wording and the best thing to
    show a reader when a value does not match.

    Keyed by the GTFS type name, which is what a field's "type" already holds.
    """
    published: dict[str, dict] = {}
    for name, definition in types.items():
        entry: dict = {"description": definition.get("description") or ""}
        if definition.get("pattern"):
            entry["pattern"] = definition["pattern"]
        for source, key in (("minimum_value", "minimum"), ("maximum_value", "maximum")):
            if definition.get(source) is not None:
                entry[key] = definition[source]
        published[name] = entry
    return dict(sorted(published.items()))


def conditions_from_rules(cls: dict) -> dict[str, str]:
    """Which slots a class's rules make conditional, and the condition in words.

    A rule's postconditions (and elseconditions, which carry the "forbidden
    otherwise" half) name the slots the condition governs, so the rule's own
    description is the explanation to show for those fields. A rule that names
    one slot in both halves - which is what "required if X, forbidden
    otherwise" is - describes it once, not twice.
    """
    conditions: dict[str, list[str]] = {}
    for rule in cls.get("rules") or []:
        description = rule.get("description") or rule.get("title") or ""
        governed = dict.fromkeys(
            slot
            for half in ("postconditions", "elseconditions")
            for slot in ((rule.get(half) or {}).get("slot_conditions") or {})
        )
        for slot in governed:
            # A slot governed by more than one rule - parent_station is required
            # for some location types and forbidden for another - keeps both
            # halves of the story.
            conditions.setdefault(slot, []).append(description)
    return {slot: " ".join(filter(None, described)) for slot, described in conditions.items()}


def contained_classes(classes: dict) -> set[str]:
    """Classes that are part of another structure rather than a file of rows.

    `locations.geojson` is described twice: as the GeoJSON document it is, and
    as the flat rows the viewer browses. Only the second is a table. The
    difference is already in the LinkML - `tree_root` marks a document's root,
    and `inlined` marks a slot that *contains* its range rather than referring
    to it - so nothing needs to be marked up specially here. A foreign key is
    not inlined, which is why the CSV classes are unaffected.
    """
    contained = {name for name, cls in classes.items() if cls.get("tree_root")}
    for cls in classes.values():
        for slot in (cls.get("attributes") or {}).values():
            slot = slot or {}
            if slot.get("inlined") or slot.get("inlined_as_list"):
                contained.add(slot.get("range"))
    return contained - {None}


IFABSENT = re.compile(r"^\s*\w+\s*\(\s*(.*?)\s*\)\s*$")


def implied_when_empty(slot: dict, values: dict | None) -> dict | None:
    """What GTFS says an empty value means, resolved to code and label.

    Most of these are LinkML's own `ifabsent`, which names one of the field's
    codes - "0 or empty - Regularly scheduled pickup". It is declared per slot
    because GTFS assigns it per field: the four `continuous_*` fields imply 1
    while `pickup_type` implies 0, and the two share an enum.

    `fare_attributes.transfers` is the exception. Its empty value means
    unlimited transfers, which is not one of its codes, so `ifabsent` has
    nothing to name and the meaning is stated in words instead.
    """
    spelled_out = annotation(slot, "gtfs_empty_means")
    if spelled_out:
        return {"label": str(spelled_out)}

    absent = slot.get("ifabsent")
    if not absent:
        return None
    match = IFABSENT.match(str(absent))
    code = match.group(1) if match else str(absent)
    return {"code": code, "label": (values or {}).get(code, code)}


def primary_key_slots(cls: dict) -> set[str]:
    """A file's primary key: a single `identifier`, or a composite `unique_keys`
    entry, which is what GTFS uses for 12 of its 31 files."""
    keys = {name for name, slot in (cls.get("attributes") or {}).items() if (slot or {}).get("identifier")}
    unique = (cls.get("unique_keys") or {}).get("primary_key") or {}
    keys.update(unique.get("unique_key_slots") or [])
    return keys


def build(schema: dict) -> dict:
    classes = schema.get("classes") or {}
    enums = schema.get("enums") or {}
    types = schema.get("types") or {}
    contained = contained_classes(classes)

    # A class is a foreign-key target only through its single-slot identifier.
    identifier_of = {
        name: next((f for f, s in (cls.get("attributes") or {}).items() if (s or {}).get("identifier")), None)
        for name, cls in classes.items()
    }

    tables: dict[str, dict] = {}
    enum_columns: set[str] = set()

    for table, cls in sorted(classes.items()):
        if table in contained:
            continue
        keys = primary_key_slots(cls)
        rule_conditions = conditions_from_rules(cls)
        fields: dict[str, dict] = {}

        for name, slot in (cls.get("attributes") or {}).items():
            slot = slot or {}
            field: dict = {}
            range_name = slot.get("range")
            references = None
            values = None

            if range_name in enums:
                field["type"] = "ENUM"
                values = {
                    code: (value or {}).get("title") or code
                    for code, value in (enums[range_name].get("permissible_values") or {}).items()
                }
            elif range_name in classes:
                field["type"] = "ID"
                target = identifier_of.get(range_name)
                # A contained class is not a table, so a slot holding one is not
                # a link a reader can follow.
                if target and range_name not in contained:
                    references = {"table": range_name, "field": target}
            elif range_name in types:
                field["type"] = range_name

            # The few references `range` cannot express: a target that is not a
            # single-slot key, such as stops.zone_id or a composite-keyed file.
            declared = annotation(slot, "gtfs_references")
            if declared and "." in str(declared):
                target_table, target_field = str(declared).split(".", 1)
                references = {"table": target_table, "field": target_field}

            condition = annotation(slot, "gtfs_condition")
            if slot.get("required") or annotation(slot, "gtfs_required") == "column_required_value_optional":
                field["required"] = "always"
            elif condition or name in rule_conditions:
                field["required"] = "conditional"
                # Prefer the annotation: it is only present where the condition
                # reaches outside the row, and so states more than a rule can.
                condition = condition or rule_conditions.get(name)
            if field.get("required") == "conditional" and condition:
                field["condition"] = condition
                facts = nested_annotations(slot, "gtfs_condition")
                # Always stated, so that "answerable from the row alone" is a
                # fact a consumer can read rather than the absence of a marker.
                field["conditionScope"] = facts.get("scope") or "row"
                check = condition_check(facts)
                if check:
                    field["conditionCheck"] = check

            if name in keys:
                field["primaryKey"] = True
            if references:
                field["references"] = references
            if values:
                field["values"] = values
                enum_columns.add(name)

            when_empty = implied_when_empty(slot, values)
            if when_empty:
                field["whenEmpty"] = when_empty

            fields[name] = field
        tables[table] = {"fields": fields}

    return {
        "$comment": COMMENT,
        "fieldTypes": field_types(types),
        "tables": tables,
        # Kept as a flat list of column names: the filter UI asks "is this
        # column enum-like" without knowing which table it came from.
        "enumLikeColumns": sorted(enum_columns),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schema", default="schema/gtfs.yaml")
    parser.add_argument("--out", default="src/gtfs_garage/data/gtfs-schema.json")
    args = parser.parse_args(argv)

    schema = yaml.safe_load(Path(args.schema).read_text(encoding="utf-8"))
    document = build(schema)
    Path(args.out).write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")

    fields = sum(len(t["fields"]) for t in document["tables"].values())
    typed = sum(1 for t in document["tables"].values() for f in t["fields"].values() if "type" in f)
    constrained = sum(1 for t in document["fieldTypes"].values() if set(t) - {"description"})
    print(
        f"wrote {args.out}: {len(document['tables'])} tables, {fields} fields, "
        f"{typed} typed, {len(document['enumLikeColumns'])} enum columns, "
        f"{len(document['fieldTypes'])} field types ({constrained} constrained)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
