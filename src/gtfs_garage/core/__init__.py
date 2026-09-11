"""Feed loading, querying and GeoJSON generation.

Nothing in this package imports a web framework: it is the reusable half of the
tool, so another project can depend on it without inheriting FastAPI. See
tests/test_layering.py, which enforces that.
"""

from gtfs_garage.core.feed import FeedStats, FileStats, GtfsFeed, GtfsLoadError
from gtfs_garage.core.queries import (
    UnknownColumnError,
    UnknownTableError,
    distinct_values,
    query_table,
    table_summaries,
)

__all__ = [
    "FeedStats",
    "FileStats",
    "GtfsFeed",
    "GtfsLoadError",
    "UnknownColumnError",
    "UnknownTableError",
    "distinct_values",
    "query_table",
    "table_summaries",
]
