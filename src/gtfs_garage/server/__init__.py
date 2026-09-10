"""FastAPI layer: turns gtfs_garage.core into an HTTP API and serves the UI."""

from gtfs_garage.server.app import create_app

__all__ = ["create_app"]
