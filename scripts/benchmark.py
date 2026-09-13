#!/usr/bin/env python
"""Measures what opening and drawing a feed costs.

Reports; never fails. Thresholds belong in tests/test_performance_guards.py,
which asserts structure rather than duration - a CI runner's speed varies enough
that a timing assertion either misses real regressions or flakes.

Two kinds of number come out of this, and the distinction is the point:

  exact   payload bytes, feature counts, vertex counts, row totals. Deterministic
          for a fixed input, so any change between two runs is a real change.
  timing  how long each phase took. Moves with whatever else the machine is
          doing, so only large differences mean anything.

`--json` emits both, keyed by kind, for scripts/compare_benchmarks.py to diff
against another run. Without it, the same numbers print as a markdown table.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tests"))

from conftest import write_feed  # noqa: E402

from gtfs_garage.core import geojson as gj  # noqa: E402
from gtfs_garage.core.feed import GtfsFeed  # noqa: E402
from gtfs_garage.core.queries import query_table, table_summaries  # noqa: E402

# Big enough that the numbers mean something and the vertex budget engages,
# small enough to build and measure in a few seconds on a shared runner.
STOPS = 40_000
SHAPES = 8_000
POINTS_PER_SHAPE = 40
# Fewer routes than shapes, so both line layers have something to draw: the
# routes layer takes one shape per route and the shapes layer takes the rest.
ROUTES = 2_000

LAYERS = (("routes", gj.iter_routes), ("stops", gj.iter_stops), ("shapes", gj.iter_shapes))

MB = 1024**2


def timed(fn):
    started = time.perf_counter()
    result = fn()
    return result, time.perf_counter() - started


def measure() -> dict:
    """Open a generated feed, summarise it, page it and build every map layer."""
    with tempfile.TemporaryDirectory() as scratch:
        directory = write_feed(Path(scratch) / "feed", STOPS, SHAPES, POINTS_PER_SHAPE, ROUTES)
        exact: dict[str, int] = {}
        timing: dict[str, float] = {}

        feed, timing["open the feed"] = timed(lambda: GtfsFeed(str(directory)))
        try:
            _, timing["summarise every table"] = timed(lambda: table_summaries(feed))
            stats = feed.stats
            timing["convert to parquet"] = (stats.convert_ms or 0) / 1000
            exact["feed on disk (bytes)"] = stats.source_bytes
            exact["stored as parquet (bytes)"] = stats.stored_bytes or 0

            page, timing["page into shapes"] = timed(
                lambda: query_table(feed, "shapes", [], page=50, page_size=100)
            )
            exact["shapes rows"] = page["total"]

            for name, builder in LAYERS:
                cursor = feed.cursor()
                features, timing[f"build {name}"] = timed(
                    lambda: [f for batch in builder(cursor) for f in batch]
                )
                exact[f"{name} payload (bytes)"] = len(json.dumps(features, separators=(",", ":")))
                exact[f"{name} features"] = len(features)
                exact[f"{name} vertices"] = sum(
                    1 if f["geometry"]["type"] == "Point" else len(f["geometry"]["coordinates"])
                    for f in features
                )

            exact["vertex step"] = gj.vertex_step(feed.cursor())
        finally:
            feed.close()

    return {
        "feed": {
            "stops": STOPS,
            "shapes": SHAPES,
            "routes": ROUTES,
            "points_per_shape": POINTS_PER_SHAPE,
            "max_map_vertices": gj.MAX_MAP_VERTICES,
        },
        "exact": exact,
        "timing": timing,
    }


def describe_feed(feed: dict) -> str:
    return (
        f"Synthetic feed: {feed['stops']:,} stops, {feed['shapes']:,} shapes "
        f"({feed['routes']:,} on routes), {feed['shapes'] * feed['points_per_shape']:,} vertices."
    )


def as_markdown(result: dict) -> str:
    lines = ["### Performance benchmark", "", describe_feed(result["feed"]), ""]
    lines += ["| Exact metric | Value |", "|---|---:|"]
    for name, value in result["exact"].items():
        lines.append(f"| {name} | {value:,} |")
    lines += ["", "| Phase | Time |", "|---|---:|"]
    for name, seconds in result["timing"].items():
        lines.append(f"| {name} | {seconds:.2f} s |")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="emit the raw numbers for comparison")
    args = parser.parse_args(argv)

    result = measure()
    print(json.dumps(result, indent=2) if args.json else as_markdown(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
