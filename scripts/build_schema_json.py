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
    range: Latitude    -> a type       -> the GTFS field type it maps to

Run after editing the LinkML:

    python scripts/build_schema_json.py
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import yaml

COMMENT = (
    "GTFS relational and field semantics, shared by the Python backend "
    "(core/schema.py) and any JavaScript/TypeScript consumer. Keyed by table, "
    "then by field, so per-field facts have somewhere to live. "
    "GENERATED from schema/gtfs.yaml by scripts/build_schema_json.py - edit that, "
    "not this. Keys are camelCase so this reads naturally from TypeScript."
)

GTFS_PREFIX = "gtfs:"


def annotation(slot: dict, name: str):
    """LinkML annotations survive as either a scalar or a {value: ...} record
    depending on how they were written; accept both."""
    annotations = slot.get("annotations") or {}
    value = annotations.get(name)
    if isinstance(value, dict):
        return value.get("value")
    return value


def gtfs_type_of(type_def: dict) -> str | None:
    """The GTFS field type a LinkML type stands for, from its exact_mappings."""
    for mapping in type_def.get("exact_mappings") or []:
        if str(mapping).startswith(GTFS_PREFIX):
            return str(mapping)[len(GTFS_PREFIX) :]
    return None


def conditions_from_rules(cls: dict) -> dict[str, str]:
    """Which slots a class's rules make conditional, and the condition in words.

    A rule's postconditions (and elseconditions, which carry the "forbidden
    otherwise" half) name the slots the condition governs, so the rule's own
    description is the explanation to show for those fields.
    """
    conditions: dict[str, str] = {}
    for rule in cls.get("rules") or []:
        description = rule.get("description") or rule.get("title") or ""
        for half in ("postconditions", "elseconditions"):
            for slot in ((rule.get(half) or {}).get("slot_conditions") or {}):
                existing = conditions.get(slot)
                # A slot governed by more than one rule - parent_station is
                # required for some location types and forbidden for another -
                # keeps both halves of the story.
                conditions[slot] = f"{existing} {description}".strip() if existing else description
    return conditions


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

    # A class is a foreign-key target only through its single-slot identifier.
    identifier_of = {
        name: next((f for f, s in (cls.get("attributes") or {}).items() if (s or {}).get("identifier")), None)
        for name, cls in classes.items()
    }

    tables: dict[str, dict] = {}
    enum_columns: set[str] = set()

    for table, cls in sorted(classes.items()):
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
                if target:
                    references = {"table": range_name, "field": target}
            elif range_name in types:
                gtfs_type = gtfs_type_of(types[range_name])
                if gtfs_type:
                    field["type"] = gtfs_type

            # The few references `range` cannot express: a target that is not a
            # single-slot key, such as stops.zone_id or a composite-keyed file.
            declared = annotation(slot, "gtfs_references")
            if declared and "." in str(declared):
                target_table, target_field = str(declared).split(".", 1)
                references = {"table": target_table, "field": target_field}

            required = annotation(slot, "gtfs_required")
            condition = annotation(slot, "gtfs_condition")
            if slot.get("required") or required == "column_required_value_optional":
                field["required"] = "always"
            elif required == "conditional" or name in rule_conditions:
                field["required"] = "conditional"
                # Prefer the annotation: it is only present where the condition
                # is not a per-row property, and so states more than any rule can.
                condition = condition or rule_conditions.get(name)
            elif required:
                field["required"] = required
            if field.get("required") == "conditional" and condition:
                field["condition"] = condition
                if annotation(slot, "gtfs_condition_enforced") is False:
                    field["conditionEnforced"] = False

            if name in keys:
                field["primaryKey"] = True
            if references:
                field["references"] = references
            if values:
                field["values"] = values
                enum_columns.add(name)

            fields[name] = field
        tables[table] = {"fields": fields}

    return {
        "$comment": COMMENT,
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
    print(
        f"wrote {args.out}: {len(document['tables'])} tables, {fields} fields, "
        f"{typed} typed, {len(document['enumLikeColumns'])} enum columns"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
