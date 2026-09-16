#!/usr/bin/env python
"""Diffs two benchmark runs and writes the result as markdown.

    compare_benchmarks.py base.json head.json

Both files come from `benchmark.py --json`, and in CI both are produced on the
same runner seconds apart - which is the only way the timings mean anything,
since a baseline recorded on another machine differs by more than most real
regressions do.

Exact metrics come first because a change in one is a change in fact: the input
is a generated feed, so payload bytes and feature counts are the same on every
run of the same code. Timings follow, marked as indicative.

A missing or unreadable base is not an error. The base commit will not always
benchmark cleanly - a pull request that changes the measurement harness is the
obvious case - and reporting the head alone with a note is more useful than
failing the job.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

MARKER = "<!-- gtfs-garage-benchmark -->"

# Below this, a timing difference says more about the runner than the code.
TIMING_NOISE_PERCENT = 10


def load(path: str) -> dict | None:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def percent(base: float, head: float) -> float | None:
    if not base:
        return None
    return (head - base) / base * 100


def format_delta(base: float | None, head: float, unit: str = "") -> str:
    if base is None:
        return "-"
    if base == head:
        return "="
    change = percent(base, head)
    if change is None:
        return f"{head - base:+,.0f}{unit}"
    return f"{change:+.1f}%"


def exact_table(base: dict | None, head: dict) -> tuple[list[str], list[str]]:
    """The exact table, and the names of whatever moved."""
    base_exact = (base or {}).get("exact", {})
    moved: list[str] = []

    lines = ["| Exact metric | Base | This PR | Change |", "|---|---:|---:|---:|"]
    for name, value in head["exact"].items():
        before = base_exact.get(name)
        if before is not None and before != value:
            moved.append(name)
        shown_before = f"{before:,}" if before is not None else "-"
        marker = " ⚠️" if before is not None and before != value else ""
        lines.append(f"| {name} | {shown_before} | {value:,} | {format_delta(before, value)}{marker} |")
    return lines, moved


def timing_table(base: dict | None, head: dict) -> list[str]:
    base_timing = (base or {}).get("timing", {})
    lines = ["| Phase | Base | This PR | Change |", "|---|---:|---:|---:|"]
    for name, seconds in head["timing"].items():
        before = base_timing.get(name)
        shown_before = f"{before:.2f} s" if before is not None else "-"
        lines.append(f"| {name} | {shown_before} | {seconds:.2f} s | {format_delta(before, seconds)} |")
    return lines


def report(base: dict | None, head: dict) -> str:
    feed = head["feed"]
    # Only claim the same-runner comparison when there is something to compare.
    provenance = (
        " Both columns were measured on this runner, one after the other."
        if base is not None
        else ""
    )
    lines = [
        MARKER,
        "### Performance",
        "",
        f"Synthetic feed: {feed['stops']:,} stops, {feed['shapes']:,} shapes "
        f"({feed['routes']:,} on routes), {feed['shapes'] * feed['points_per_shape']:,} vertices."
        f"{provenance}",
        "",
    ]

    if base is None:
        lines += [
            "> The base commit could not be benchmarked, so there is nothing to compare "
            "against and only this branch's numbers are shown. That is expected when the "
            "base predates a metric this branch adds.",
            "",
        ]

    exact_lines, moved = exact_table(base, head)
    lines += exact_lines + [""]

    if base is not None:
        if moved:
            lines += [f"**{len(moved)} exact metric(s) changed:** " + ", ".join(moved) + ".", ""]
        else:
            lines += ["No exact metric changed.", ""]

    lines += ["<details><summary>Timings</summary>", ""]
    lines += timing_table(base, head)
    lines += [
        "",
        f"Timings move with the runner. Treat anything under about {TIMING_NOISE_PERCENT}% as noise; "
        "the exact metrics above are what a change can be read from.",
        "</details>",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compare two benchmark runs.")
    parser.add_argument("base", help="benchmark --json from the base commit")
    parser.add_argument("head", help="benchmark --json from this branch")
    args = parser.parse_args(argv)

    head = load(args.head)
    if head is None:
        # A missing base is tolerable - that step is allowed to fail, since the
        # base commit may not benchmark. A missing head means this branch's own
        # measurement produced nothing, which is a broken harness rather than an
        # absence of news, so it fails the check instead of posting an apology
        # under a green tick. The comment still goes up, carrying the reason.
        print(f"{MARKER}\n### Performance\n\nThe benchmark did not produce a result for this branch.")
        print(f"{args.head} is missing or is not valid JSON", file=sys.stderr)
        return 1

    print(report(load(args.base), head))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
