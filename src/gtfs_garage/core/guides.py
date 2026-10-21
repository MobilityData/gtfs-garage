"""What a Quality guide may say, and the check that holds a guide to it.

A guide (`schema/guides/<code>.yaml`) tells the Quality assistant how to walk a
reader through one gtfs-validator notice. It is data written against two things
this project does not control in the same place: the field names of the
validator's samples, and the actions the viewer implements in
`web/src/quality/actions.ts`. This module is the one statement of the second,
and the check of a guide against both.

It is used by `scripts/build_guides.py`, which checks the guides in the
repository, and by the server, which checks a guide an analyst saves. The
action vocabulary is also written into the catalog (`action_specs`), so the
viewer's editor builds its forms from it and checks a draft by the same rules
without a second copy to keep in step.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

# The formatters a template may name after `|`. Implemented in
# web/src/quality/template.ts.
FORMATTERS = {"m", "km", "kmh", "date", "round", "coord", "yesno", "words", "from1", "min", "days"}

# `rows`: let go of the rows an earlier step opened, which otherwise stay shown.
SURFACES = {"map", "panel", "rows"}
# What a step's card may point at; see `point` in web/src/quality/catalog.ts.
POINTS = {"rows", "map"}
STEP_KEYS = {"text", "actions", "clear", "point"}
GUIDE_KEYS = {"code", "locators", "steps", "fix"}
LOCATOR_KEYS = {"file", "line", "key"}
PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z0-9_]+)\s*(?:\|\s*([A-Za-z0-9]+)\s*)?\}\}")
# Anything in braces at all, to catch one PLACEHOLDER cannot read: it would be shown as typed.
BRACES = re.compile(r"\{\{.*?\}\}")


def _arg(type_: str, label: str, *, required: bool = False, **extra: Any) -> dict[str, Any]:
    return {"type": type_, "label": label, "required": required, **extra}


# Every action kind a guide may use, implemented in web/src/quality/actions.ts;
# a kind added there is added here.
#
# `surface` is what the action changes: `content` replaces the table or screen
# (one per step at most), `map` draws on the map, `panel` adds to the step's
# card. Each argument has a type, which the editor turns into a form field:
#
#   locator      the name of one of the guide's locators
#   column       one column of the file a locator (`of`) names
#   columns      several columns of that file
#   text         a value, usually one `{{field}}` of the sample
#   text_list    several such values
#   integer, number, boolean
#   enum         one of `values`
#   endpoint     a stop or a point: {stop: ...} or {point: ...}
#   point_list   places, each one field holding [lat, lon] or a [lat, lon] pair
#   edge         a reference between two files: {from: file.field, to: file.field}
#   object       anything; passed to a host's handler unread
ACTIONS: dict[str, dict[str, Any]] = {
    "open_rows": {
        "label": "Open rows",
        "surface": "content",
        "args": {
            "at": _arg("locator", "Rows", required=True),
            "mark": _arg("locator", "Pick out these rows among them"),
            "highlight": _arg("columns", "Outline columns", of="at"),
            # empty: finding no rows is the point. any: none is a fine answer too.
            "expect": _arg("enum", "Finding", values=["empty", "any"]),
            "around": _arg("integer", "Lines either side", min=0),
        },
    },
    "follow_link": {
        "label": "Follow a link",
        "surface": "content",
        "args": {
            "from": _arg("locator", "From", required=True),
            "to": _arg("locator", "To", required=True),
        },
    },
    "timetable": {
        "label": "Timetable",
        "surface": "content",
        "args": {
            # Without a route, the trip's own, looked up in trips.txt.
            "route": _arg("text", "Route"),
            "trip": _arg("text", "Trip"),
            "date": _arg("text", "Date"),
        },
    },
    "calendar": {
        "label": "Service days",
        "surface": "content",
        "args": {"date": _arg("text", "Date")},
    },
    "map_focus": {
        "label": "Draw on the map",
        "surface": "map",
        "args": {
            "routes": _arg("text_list", "Routes"),
            "shapes": _arg("text_list", "Shapes"),
            "stops": _arg("text_list", "Stops"),
            "points": _arg("point_list", "Points"),
            "locations": _arg("text_list", "Zones (locations.geojson ids)"),
        },
    },
    "map_measure": {
        "label": "Measure a distance",
        "surface": "map",
        "args": {
            "from": _arg("endpoint", "From", required=True),
            "to": _arg("endpoint", "To", required=True),
            "threshold": _arg("number", "Warn over (m)", min=0),
        },
    },
    "map_sequence": {
        "label": "Number a trip's calls",
        "surface": "map",
        "args": {
            "trip": _arg("text", "Trip", required=True),
            "mark": _arg("text_list", "Pick out stops"),
            "speeds": _arg("boolean", "Label each leg with its speed"),
            "limit": _arg("number", "Warn over (km/h)", min=0),
        },
    },
    "map_play": {
        "label": "Play a trip",
        "surface": "map",
        "args": {
            "trip": _arg("text", "Trip", required=True),
            "from": _arg("text", "From stop"),
            "to": _arg("text", "To stop"),
            "around": _arg("integer", "Calls either side", min=0),
            "mark": _arg("text_list", "Pick out stops"),
            "limit": _arg("number", "Warn over (km/h)", min=0),
        },
    },
    "show_record": {
        "label": "Show a record",
        "surface": "panel",
        "args": {
            "at": _arg("locator", "Row", required=True),
            "fields": _arg("columns", "Fields", of="at"),
        },
    },
    "compare_records": {
        "label": "Compare two records",
        "surface": "panel",
        "args": {
            "a": _arg("locator", "First", required=True),
            "b": _arg("locator", "Second", required=True),
            "fields": _arg("columns", "Fields", of="a"),
        },
    },
    "show_model": {
        "label": "How the files connect",
        "surface": "panel",
        "args": {
            "files": _arg("text_list", "Files", required=True),
            "edge": _arg("edge", "Reference to pick out"),
        },
    },
    "chart": {
        "label": "Chart two columns",
        "surface": "panel",
        "args": {
            "at": _arg("locator", "Rows", required=True),
            "x": _arg("column", "Across", of="at", required=True),
            "y": _arg("column", "Up", of="at", required=True),
            "mark": _arg("text_list", "Mark lines"),
        },
    },
    # Shown in the card, for findings that are not about a row a reader can
    # look at; see web/src/quality/explainers.ts.
    "show_files": {
        "label": "Show the feed's files",
        "surface": "panel",
        "args": {
            "missing": _arg("text_list", "Files it lacks"),
            "mark": _arg("text_list", "Files to pick out"),
        },
    },
    "show_columns": {
        "label": "Show a file's columns",
        "surface": "panel",
        "args": {
            "file": _arg("text", "File", required=True),
            "missing": _arg("text_list", "Columns it lacks"),
            "mark": _arg("text_list", "Columns to pick out"),
        },
    },
    "show_value": {
        "label": "Show a value, invisible characters too",
        "surface": "panel",
        "args": {
            "value": _arg("text", "Value", required=True),
            "label": _arg("text", "What it is"),
            "expect": _arg("text", "What it should look like"),
        },
    },
    "show_colors": {
        "label": "Show colours and their contrast",
        "surface": "panel",
        "args": {
            "color": _arg("text", "Background colour", required=True),
            "text": _arg("text", "Text colour"),
            "label": _arg("text", "Label to draw"),
        },
    },
    "timeline": {
        "label": "Show dates on a timeline",
        "surface": "panel",
        "args": {
            "start": _arg("text", "Starts", required=True),
            "end": _arg("text", "Ends", required=True),
            "checked": _arg("text", "Checked on"),
            "start_label": _arg("text", "What the start is"),
            "end_label": _arg("text", "What the end is"),
            "count": _arg("enum", "Its length", values=["inclusive", "between", "none"]),
            "other_start": _arg("text", "A second range starts"),
            "other_end": _arg("text", "A second range ends"),
            "other_label": _arg("text", "What the second range is"),
        },
    },
    "custom": {
        "label": "Host action",
        "surface": "any",
        "args": {
            "handler": _arg("text", "Handler", required=True),
            "args": _arg("object", "Arguments"),
        },
    },
}

CONTENT_ACTIONS = {kind for kind, spec in ACTIONS.items() if spec["surface"] == "content"}


class GuideError(ValueError):
    pass


def locator_arguments(kind: str) -> list[str]:
    return [name for name, arg in ACTIONS[kind]["args"].items() if arg["type"] == "locator"]


def strings_in(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [s for item in value for s in strings_in(item)]
    if isinstance(value, dict):
        return [s for key, item in value.items() for s in strings_in(key) + strings_in(item)]
    return []


def check_templates(where: str, value: Any, fields: set[str]) -> None:
    for text in strings_in(value):
        for braces in BRACES.findall(text):
            if not PLACEHOLDER.fullmatch(braces):
                shape = "{{field}} or {{field|formatter}}"
                raise GuideError(f"{where}: {braces} is not a placeholder: write {shape}")
        for name, formatter in PLACEHOLDER.findall(text):
            if name not in fields:
                raise GuideError(f"{where}: {{{{{name}}}}} is not a field of this notice ({', '.join(sorted(fields))})")
            if formatter and formatter not in FORMATTERS:
                raise GuideError(f"{where}: unknown formatter '|{formatter}' (known: {', '.join(sorted(FORMATTERS))})")


def check_guide(code: str, guide: Any, fields: Iterable[str]) -> dict:
    """`guide` if it is one the viewer can carry out for `code`, else a GuideError.

    `fields` are the fields of the notice's samples, as rules.json names them.
    """
    fields = set(fields)
    if not isinstance(guide, dict):
        raise GuideError(f"{code}: a guide is a mapping")
    if guide.get("code") != code:
        raise GuideError(f"{code}.yaml: `code` must be {code!r}, found {guide.get('code')!r}")
    unknown_keys = set(guide) - GUIDE_KEYS
    if unknown_keys:
        raise GuideError(f"{code}: unknown keys {sorted(unknown_keys)}")

    locators = guide.get("locators") or {}
    if not isinstance(locators, dict):
        raise GuideError(f"{code}: `locators` must be a mapping")
    for name, locator in locators.items():
        where = f"{code}: locator {name}"
        if not isinstance(locator, dict) or not locator.get("file"):
            raise GuideError(f"{where}: needs a `file`")
        if set(locator) - LOCATOR_KEYS:
            raise GuideError(f"{where}: unknown keys {sorted(set(locator) - LOCATOR_KEYS)}")
        check_templates(where, locator, fields)

    steps = guide.get("steps") or []
    if not isinstance(steps, list) or not steps:
        raise GuideError(f"{code}: needs at least one step")
    for index, step in enumerate(steps, start=1):
        where = f"{code}: step {index}"
        if not isinstance(step, dict) or not isinstance(step.get("text"), str) or not step["text"]:
            raise GuideError(f"{where}: needs `text`")
        if set(step) - STEP_KEYS:
            raise GuideError(f"{where}: unknown keys {sorted(set(step) - STEP_KEYS)}")
        if step.get("point") not in (None, *POINTS):
            raise GuideError(f"{where}: cannot point at {step['point']!r} (only {sorted(POINTS)})")
        check_templates(where, step["text"], fields)
        clear = step.get("clear") or []
        if not isinstance(clear, list):
            raise GuideError(f"{where}: `clear` must be a list")
        for surface in clear:
            if surface not in SURFACES:
                raise GuideError(f"{where}: cannot clear {surface!r} (only {sorted(SURFACES)})")
        actions = step.get("actions") or []
        if not isinstance(actions, list):
            raise GuideError(f"{where}: `actions` must be a list")
        content = 0
        for action in actions:
            kind = action.get("kind") if isinstance(action, dict) else None
            if kind not in ACTIONS:
                raise GuideError(f"{where}: unknown action {kind!r} (known: {', '.join(sorted(ACTIONS))})")
            spec = ACTIONS[kind]["args"]
            extra = set(action) - {"kind"} - set(spec)
            if extra:
                raise GuideError(f"{where}: {kind} does not take {sorted(extra)}")
            missing = [name for name, arg in spec.items() if arg["required"] and action.get(name) in (None, "", [])]
            if missing:
                raise GuideError(f"{where}: {kind} needs {', '.join(missing)}")
            for argument in locator_arguments(kind):
                if argument in action and (not isinstance(action[argument], str) or action[argument] not in locators):
                    raise GuideError(f"{where}: {kind}.{argument} names undeclared locator {action[argument]!r}")
            if kind in CONTENT_ACTIONS:
                content += 1
            check_templates(f"{where} {kind}", {k: v for k, v in action.items() if k != "kind"}, fields)
        if content > 1:
            raise GuideError(f"{where}: at most one action may change the table or screen; found {content}")

    fix = guide.get("fix") or []
    if not isinstance(fix, list):
        raise GuideError(f"{code}: `fix` must be a list")
    for index, line in enumerate(fix, start=1):
        if not isinstance(line, str):
            raise GuideError(f"{code}: fix {index}: needs to be a sentence")
        check_templates(f"{code}: fix {index}", line, fields)
    return guide


def vocabulary() -> dict[str, Any]:
    """What the catalog tells the viewer about writing guides."""
    return {
        "formatters": sorted(FORMATTERS),
        "actions": sorted(ACTIONS),
        "action_specs": ACTIONS,
        "surfaces": sorted(SURFACES),
        "points": sorted(POINTS),
    }
