"""The packaged data's old import path, kept so existing readers keep working.

The packaged schema moved with the core into `gtfs_garage_core.data`.
`importlib.resources.files("gtfs_garage.data")` still finds it, because this
name is the same package.
"""

import sys

import gtfs_garage_core.data

sys.modules[__name__] = gtfs_garage_core.data
