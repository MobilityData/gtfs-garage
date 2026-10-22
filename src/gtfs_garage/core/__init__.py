"""The core's old import path, kept so existing imports keep working.

The core moved to its own distribution, `gtfs-garage-core`, imported as
`gtfs_garage_core`. Anything written against `gtfs_garage.core` - this
repository's scripts, `mobility-feed-api`, a notebook - is still served, and
served the same module objects rather than copies: `gtfs_garage.core.feed` *is*
`gtfs_garage_core.feed`, so `isinstance`, `mock.patch("gtfs_garage.core....")`
and module-level state behave as they did before the move.

Every submodule is registered under the old name up front. Importing them all
costs little - `feed` alone pulls in most of the others - and it is what makes
`from gtfs_garage.core.feed import GtfsFeed` resolve without a custom importer.
"""

import importlib
import pkgutil
import sys

import gtfs_garage_core

for _module in pkgutil.iter_modules(gtfs_garage_core.__path__):
    sys.modules[f"{__name__}.{_module.name}"] = importlib.import_module(f"gtfs_garage_core.{_module.name}")

sys.modules[__name__] = gtfs_garage_core
