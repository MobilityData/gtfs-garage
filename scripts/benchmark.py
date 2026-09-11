#!/usr/bin/env python
"""Measures what opening and drawing a feed costs, and prints a markdown table.

Reports; never fails. Thresholds belong in tests/test_performance_guards.py,
which asserts structure rather than duration - a CI runner's speed varies enough
that a timing assertion either misses real regressions or flakes. What this is
for is a number on the pull request that a reviewer can compare against the same
table on main.

Run directly (`python scripts/benchmark.py`) or let CI append it to the job
summary.
"""

from __future__ import annotations

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

MB = 1024**2


def timed(fn):
    started = time.perf_counter()
    result = fn()
    return result, time.perf_counter() - started


def main() -> int:
    with tempfile.TemporaryDirectory() as scratch:
        directory = write_feed(Path(scratch) / "feed", STOPS, SHAPES, POINTS_PER_SHAPE, ROUTES)
        vertices = SHAPES * POINTS_PER_SHAPE

        feed, load_seconds = timed(lambda: GtfsFeed(str(directory)))
        try:
            _, summary_seconds = timed(lambda: table_summaries(feed))
            stats = feed.stats

            print("### Performance benchmark\n")
            print(f"Synthetic feed: {STOPS:,} stops, {SHAPES:,} shapes ({ROUTES:,} on routes), {vertices:,} vertices.\n")
            print("| Phase | Time | Notes |")
            print("|---|---|---|")
            print(f"| Open the feed | {load_seconds:.2f} s | read headers and convert |")
            print(
                f"| - convert to Parquet | {(stats.convert_ms or 0) / 1000:.2f} s | "
                f"{(stats.stored_bytes or 0) / MB:.1f} MB stored vs {stats.source_bytes / MB:.1f} MB of CSV |"
            )
            print(f"| Summarise every table | {summary_seconds:.2f} s | the row counts the sidebar shows |")

            page, page_seconds = timed(lambda: query_table(feed, "shapes", [], page=50, page_size=100))
            print(f"| Page into shapes | {page_seconds:.3f} s | row {page['page'] * 100:,} of {page['total']:,} |")

            print("\n| Map layer | Build | Payload | Features | Vertices |")
            print("|---|---|---|---|---|")
            for name, builder in (
                ("routes", gj.iter_routes),
                ("stops", gj.iter_stops),
                ("shapes", gj.iter_shapes),
            ):
                cursor = feed.cursor()
                features, seconds = timed(lambda: [f for batch in builder(cursor) for f in batch])
                payload = len(json.dumps(features, separators=(",", ":")))
                coords = sum(
                    1 if f["geometry"]["type"] == "Point" else len(f["geometry"]["coordinates"]) for f in features
                )
                print(f"| {name} | {seconds:.2f} s | {payload / MB:.1f} MB | {len(features):,} | {coords:,} |")

            step = gj.vertex_step(feed.cursor())
            print(
                f"\nVertex step: {step} "
                f"(`MAX_MAP_VERTICES` = {gj.MAX_MAP_VERTICES:,}; 1 means the feed is drawn exactly)."
            )
        finally:
            feed.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
