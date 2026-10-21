"""The Quality catalog: generated, committed, and checked against the validator.

`src/gtfs_garage/data/guides.json` is built from the vendored rules.json and the
guides in schema/guides/. These tests hold the committed copy to its sources and
make sure the build refuses what the viewer could not carry out.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from gtfs_garage.core import guides as rules

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "build_guides.py"
PACKAGED = ROOT / "src" / "gtfs_garage" / "data" / "guides.json"


@pytest.fixture(scope="module")
def builder():
    if not SCRIPT.exists():
        pytest.skip("the build script is not in an installed wheel")
    spec = importlib.util.spec_from_file_location("build_guides", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_packaged_catalog_matches_its_sources(builder):
    """If this fails, run scripts/build-guides.sh and commit the result."""
    rebuilt = builder.build(builder.RULES, builder.GUIDES)
    assert json.loads(PACKAGED.read_text(encoding="utf-8")) == rebuilt


def test_every_validator_code_is_in_the_catalog(builder):
    published = json.loads(builder.RULES.read_text(encoding="utf-8"))
    catalog = json.loads(PACKAGED.read_text(encoding="utf-8"))
    assert set(catalog["notices"]) == set(published)


def test_descriptions_carry_no_markup():
    catalog = json.loads(PACKAGED.read_text(encoding="utf-8"))
    for code, notice in catalog["notices"].items():
        assert "<" not in notice["description"] or "</" not in notice["description"], code


def test_a_guide_for_a_code_the_validator_does_not_emit(builder, tmp_path: Path):
    (tmp_path / "not_a_notice.yaml").write_text("code: not_a_notice\nsteps: [{text: t}]\n", encoding="utf-8")
    with pytest.raises(builder.GuideError, match="no notice"):
        builder.build(builder.RULES, tmp_path)


def test_html_tables_become_one_row_per_line(builder):
    text = "Limits:\n<table><tr><th>Type</th><th>km/h</th></tr>\n<tr><td>3</td><td>150</td></tr></table>"
    assert builder.plain(text) == "Limits:\nType | km/h\n3 | 150"


def test_every_action_argument_has_a_type_the_editor_knows():
    known = {"locator", "column", "columns", "text", "text_list", "integer", "number", "boolean", "enum"}
    known |= {"endpoint", "point_list", "edge", "object"}
    for kind, spec in rules.ACTIONS.items():
        assert spec["surface"] in {"content", "map", "panel", "any"}, kind
        for name, arg in spec["args"].items():
            assert arg["type"] in known, f"{kind}.{name}"
            if arg["type"] in {"column", "columns"}:
                assert spec["args"][arg["of"]]["type"] == "locator", f"{kind}.{name}"


def test_the_catalog_carries_the_vocabulary():
    catalog = json.loads(PACKAGED.read_text(encoding="utf-8"))
    assert catalog["action_specs"] == json.loads(json.dumps(rules.ACTIONS))


CASES = json.loads((ROOT / "tests" / "data" / "guides" / "cases.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES["cases"], ids=lambda case: case["name"])
def test_the_cases_the_viewer_checks_too(case):
    """The same file is run by web/src/quality/validate.test.ts, so both agree."""
    if case["error"] is None:
        rules.check_guide(CASES["code"], case["guide"], CASES["fields"])
        return
    with pytest.raises(rules.GuideError) as raised:
        rules.check_guide(CASES["code"], case["guide"], CASES["fields"])
    assert str(raised.value) == case["error"]
