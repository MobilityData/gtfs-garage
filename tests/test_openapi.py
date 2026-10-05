"""The spec is the contract, so the server is held to it.

`docs/GtfsGarageAPI.yaml` is hand-written and everything else is generated from
it: the models under `gtfs_garage_gen`, and the viewer's TypeScript types. That
only means anything if the running server still serves what the document
declares, which is what these check - a route removed, renamed or repointed at a
different model fails here rather than at whoever implemented the spec.

Nothing here runs the generator. It needs java and the network, and a test that
quietly regenerates would be asserting the state of someone's machine.
"""

import hashlib
import json
from pathlib import Path

import pytest
import yaml

from gtfs_garage.core.feed import GtfsFeed
from gtfs_garage.server.app import create_app
from gtfs_garage_gen.models.dataset_manifest import DatasetManifest

REPO_ROOT = Path(__file__).resolve().parents[1]
SPEC_PATH = REPO_ROOT / "docs" / "GtfsGarageAPI.yaml"
GENERATED_PACKAGE = REPO_ROOT / "src" / "gtfs_garage_gen"


@pytest.fixture(scope="module")
def spec() -> dict:
    return yaml.safe_load(SPEC_PATH.read_text(encoding="utf-8"))


METHODS = {"get", "post", "put", "patch", "delete"}


def operations(document: dict) -> set[tuple[str, str]]:
    """Every (method, path) an OpenAPI document declares."""
    return {(method.upper(), path) for path, item in document["paths"].items() for method in item if method in METHODS}


def success_schemas(document: dict) -> dict[tuple[str, str], str]:
    """The schema name each operation returns on success, where it names one."""
    found = {}
    for path, item in document["paths"].items():
        for method, operation in item.items():
            if method not in METHODS:
                continue
            for code in ("200", "202"):
                response = operation.get("responses", {}).get(code)
                if not isinstance(response, dict):
                    continue
                schema = (response.get("content") or {}).get("application/json", {}).get("schema", {})
                ref = schema.get("$ref")
                if ref:
                    found[(method.upper(), path)] = ref.rsplit("/", 1)[-1]
    return found


@pytest.fixture(scope="module")
def served() -> dict:
    """What the running server publishes about itself.

    Compared against the authored spec as one document against another, rather
    than by walking `app.routes`: FastAPI nests an included router behind a
    private attribute, and a test reaching into that breaks on an upgrade
    without the contract having changed at all.
    """
    return create_app().openapi()


def test_every_declared_operation_is_served(spec: dict, served: dict):
    missing = operations(spec) - operations(served)
    assert not missing, f"declared in the spec but not served: {sorted(missing)}"


def test_every_served_operation_is_declared(spec: dict, served: dict):
    """The direction that catches an endpoint added without saying so.

    An undeclared endpoint is worse than a missing one: a host reimplementing
    this API from the document would not know to build it, and would find out
    from a viewer that does not work.
    """
    extra = operations(served) - operations(spec)
    assert not extra, f"served but absent from the spec: {sorted(extra)}"


def test_responses_use_the_model_the_spec_names(spec: dict, served: dict):
    """A route returns the schema the document points at.

    Repointing a route at a different model is a contract change that would
    otherwise be invisible: the endpoint still answers, with a different shape.
    """
    declared = success_schemas(spec)
    actual = success_schemas(served)

    for operation, schema in declared.items():
        assert operation in actual, f"{operation[0]} {operation[1]} declares {schema} but returns no model"
        assert (
            actual[operation] == schema
        ), f"{operation[0]} {operation[1]} returns {actual[operation]}, the spec says {schema}"


def test_the_generated_models_match_the_spec():
    """The committed models are the ones this spec produces.

    Generated-and-committed can drift: edit the YAML, forget to regenerate, and
    the document and the code disagree while both look fine. The stamp is
    written by scripts/api-gen.sh from the spec's contents, so this compares the
    spec against the one the models were built from.
    """
    stamp = GENERATED_PACKAGE / ".spec-sha256"
    assert stamp.is_file(), "no generation stamp; run scripts/api-gen.sh"

    digest = hashlib.sha256(SPEC_PATH.read_bytes()).hexdigest()
    assert (
        stamp.read_text().strip() == digest
    ), "docs/GtfsGarageAPI.yaml has changed since the models were generated - run scripts/api-gen.sh"


def test_an_exported_dataset_matches_the_published_manifest_schema(feed: GtfsFeed, tmp_path: Path):
    """`manifest.json` is in the spec, and a reader is entitled to trust it.

    Nothing else holds it there: the manifest is written by `core/`, which
    cannot import pydantic, so the document and the writer would otherwise agree
    only by having been edited together.
    """
    feed.export_parquet(tmp_path / "out")
    written = json.loads((tmp_path / "out" / "manifest.json").read_text(encoding="utf-8"))

    manifest = DatasetManifest.from_dict(written)
    assert manifest is not None
    assert manifest.version == 2
    assert {table.name for table in manifest.tables} == set(feed.tables)
