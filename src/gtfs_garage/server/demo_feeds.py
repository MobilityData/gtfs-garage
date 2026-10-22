"""Demo feeds served beside the feed being browsed, never in its place.

A server holds one feed at a time, and the Tour Studio tries tours on demo
feeds while the reader's own stays open in another tab. So each demo gets a
registry of its own, opened the first time it is asked for, and answers the
read-only API under `/demos/<id>/api/...`; the server's own feed is untouched.

A built-in demo is opened from the slot of kind `demo` an earlier run left in
the workdir when there is one, rather than converted again: converting
prepares the slot afresh, which would pull files from under any other reader.
A demo of your own reads the workdir slot of the feed it is made of.
"""

from __future__ import annotations

import threading

from gtfs_garage.quality import demos
from gtfs_garage_core.workspace import DEMO_KIND, Workspace
from gtfs_garage.server.state import FeedRegistry


class UnknownDemoError(LookupError):
    pass


class DemoFeeds:
    def __init__(self, workspace: Workspace, optimise: bool = True) -> None:
        self.workspace = workspace
        self.optimise = optimise
        self._registries: dict[str, FeedRegistry] = {}
        self._lock = threading.Lock()

    def registry(self, demo_id: str) -> FeedRegistry:
        """The demo's registry, its feed open. Raises UnknownDemoError, or GtfsLoadError when it cannot be opened."""
        with self._lock:
            found = self._registries.get(demo_id)
            if found is not None:
                return found
            demo = demos.find(self.workspace, demo_id)
            if demo is None or not demos.available(self.workspace, demo):
                raise UnknownDemoError(demo_id)
            registry = FeedRegistry(optimise=self.optimise, workspace=self.workspace)
            try:
                kept = self._kept_slot(demo)
                if kept:
                    registry.reopen(kept)
                else:
                    registry.load_demo(demo)
            finally:
                registry.finish_load()
            self._registries[demo_id] = registry
            return registry

    def _kept_slot(self, demo: demos.Demo) -> str | None:
        if not demo.builtin:
            return None
        label = f"Demo: {demo.title}"
        entry = next(
            (e for e in self.workspace.entries() if e.kind == DEMO_KIND and e.label == label and e.reloadable),
            None,
        )
        return entry.id if entry else None

    def forget(self, demo_id: str) -> None:
        """Close a demo's feed: the demo was removed."""
        with self._lock:
            registry = self._registries.pop(demo_id, None)
        if registry is not None:
            registry.close()

    def held_slots(self) -> set[str]:
        """Workdir slots open for a demo, which must not be deleted."""
        with self._lock:
            registries = list(self._registries.values())
        return set().union(*(registry.held_slots() for registry in registries)) if registries else set()

    def close(self) -> None:
        with self._lock:
            registries = list(self._registries.values())
            self._registries.clear()
        for registry in registries:
            registry.close()
