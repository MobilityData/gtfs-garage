"""Every figure in the benchmark report must be one a reader can act on.

`scripts/compare_benchmarks.py` writes the comment posted on every pull request.
Its failure mode is quiet: a phase rounds to "0.00 s" in both columns while its
percentage is computed from the digits the rounding threw away, and the report
tells the reader to treat anything under 10% as noise - so the row with no
information behind it is the one that reads as significant.

Loaded by path rather than through sys.path: these are scripts, not package
modules, and the suite runs with --import-mode=importlib.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    # compare_benchmarks imports format_duration from benchmark, and resolves it
    # the same way in CI, where both are copied into a pinned harness directory.
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


benchmark = load("benchmark")
compare = load("compare_benchmarks")


class TestFormatDuration:
    """What the two timing columns show."""

    def test_a_short_phase_keeps_its_magnitude(self):
        """Two decimals of a second erase anything under 5 ms."""
        assert benchmark.format_duration(0.00120) == "1.2 ms"
        assert benchmark.format_duration(0.00146) == "1.5 ms"

    @pytest.mark.parametrize("seconds", [0.0001, 0.0012, 0.01, 0.12, 0.5, 0.999])
    def test_no_real_duration_renders_as_zero(self, seconds: float):
        assert float(benchmark.format_duration(seconds).split()[0]) > 0

    def test_a_second_or_more_is_shown_in_seconds(self):
        assert benchmark.format_duration(1.0) == "1.00 s"
        assert benchmark.format_duration(2.5) == "2.50 s"
        assert benchmark.format_duration(0.999) == "999.0 ms"

    def test_zero_is_zero(self):
        assert benchmark.format_duration(0.0) == "0.0 ms"


class TestFormatTimingDelta:
    """Whether a phase gets a percentage, and when it must not."""

    def test_a_phase_too_short_to_compare_reports_how_much_it_moved(self):
        """A quarter of a millisecond is scheduling, and reads as one when shown."""
        assert compare.format_timing_delta(0.00120, 0.00146) == "+0.3 ms"

    def test_a_phase_too_short_to_compare_never_reports_a_percentage(self):
        assert "%" not in compare.format_timing_delta(0.0001, 0.0009)

    def test_a_long_enough_phase_still_reports_a_percentage(self):
        assert compare.format_timing_delta(0.50, 0.5011) == "+0.2%"
        assert compare.format_timing_delta(0.10, 0.11) == "+10.0%"

    def test_a_base_of_zero_carries_a_unit(self):
        """A falsy base skips the percentage branch, and the integer format it
        falls back to takes a unit argument the timing table has no reason to
        pass - so an unguarded zero prints a bare `+0`."""
        rendered = compare.format_timing_delta(0.0, 0.0013)
        assert rendered == "+1.3 ms"
        assert rendered != "+0"

    def test_unchanged_and_absent_are_unchanged(self):
        assert compare.format_timing_delta(0.5, 0.5) == "="
        assert compare.format_timing_delta(None, 0.5) == "-"


class TestTables:
    def test_the_timing_table_shows_both_kinds_of_row(self):
        base = {"timing": {"summarise every table": 0.00120, "build shapes": 0.50}}
        head = {"timing": {"summarise every table": 0.00146, "build shapes": 0.5011}}
        rows = compare.timing_table(base, head)

        assert "| summarise every table | 1.2 ms | 1.5 ms | +0.3 ms |" in rows
        assert "| build shapes | 500.0 ms | 501.1 ms | +0.2% |" in rows

    def test_the_exact_table_is_untouched(self):
        """Exact metrics are integers and are read as fact, so they keep
        percentages and the marker on anything that moved."""
        base = {"exact": {"shapes rows": 320_000, "stops features": 40_000}}
        head = {"exact": {"shapes rows": 320_000, "stops features": 44_000}}
        rows, moved = compare.exact_table(base, head)

        assert moved == ["stops features"]
        assert "| shapes rows | 320,000 | 320,000 | = |" in rows
        assert "| stops features | 40,000 | 44,000 | +10.0% ⚠️ |" in rows

    def test_the_report_explains_the_rows_that_carry_no_percentage(self):
        base = {"exact": {}, "timing": {"summarise every table": 0.0012}}
        head = {
            "feed": {"stops": 10, "shapes": 2, "routes": 1, "points_per_shape": 4},
            "exact": {},
            "timing": {"summarise every table": 0.0015},
        }
        body = compare.report(base, head)

        assert "+0.3 ms" in body
        assert "shows how much it moved rather than by what proportion" in body
