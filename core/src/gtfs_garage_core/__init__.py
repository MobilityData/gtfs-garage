"""Feed loading, querying and GeoJSON generation.

Nothing in this package imports a web framework: it is the reusable half of the
tool, so another project can depend on it without inheriting FastAPI. It is
published on its own as `gtfs-garage-core`, and `gtfs-garage` adds the server
and the interface on top. See tests/test_layering.py, which enforces that.
"""

# Released in lockstep with gtfs-garage, which pins this exact version. Defined
# before the imports below, because `convert` reads it while this module is
# still being initialised.
__version__ = "0.6.0"

from gtfs_garage_core.feed import FeedStats, FileStats, GtfsFeed, GtfsLoadError  # noqa: E402
from gtfs_garage_core.queries import (  # noqa: E402
    UnknownColumnError,
    UnknownTableError,
    distinct_values,
    query_table,
    table_summaries,
)

__all__ = [
    "__version__",
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
